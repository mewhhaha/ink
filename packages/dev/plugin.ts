/**
 * The Ink Vite plugin: keeps a retained Blot compiler session, serves the
 * dev API under `/__ink/` and pushes changes to the page as custom HMR events
 * (`ink:game`, `ink:diagnostics`, `ink:project`, `ink:asset`, `ink:scene`,
 * `ink:comments`). Nothing here triggers a page reload.
 *
 * Schema design: `schema.ts` stays the single source of truth. The server
 * imports it natively (cache-busted) to generate `schema.gen.blot`; the
 * browser imports the very same file through Vite from `project.schemaUrl`,
 * which carries a version query. The plugin swallows Vite's own HMR for the
 * file, so an edit becomes one `ink:project` event instead of a reload, and
 * the app re-imports the new module in place.
 */
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  dirname,
  extname,
  join,
  relative,
  resolve,
  SEPARATOR as sep,
} from "@std/path";
import type { Plugin, ViteDevServer } from "vite";
import type { Catalog, Schema } from "@ink/schema";
import {
  createGameCompiler,
  type Diagnostic,
  type GameCompiler,
} from "@ink/blot/compiler";
import type { ProjectConfig } from "./project.ts";
import type {
  BundleRequest,
  BundleResult,
  DevDiagnostic,
  DevEvents,
  GameInfo,
  ProjectInfo,
} from "./protocol.ts";
import { assetKind, scanAssets } from "./catalog.ts";
import {
  allowedDirs,
  exists,
  loadSchema,
  type ResolvedProject,
  resolveProject,
} from "./node.ts";
import {
  checkName,
  makeId,
  PathError,
  resolveInside,
  stableJson,
} from "./paths.ts";

const KEEP_REVISIONS = 4;

const reset = "\x1b[0m";
const color = (code: number) => (text: string) =>
  Deno.stdout.isTerminal() ? `\x1b[${code}m${text}${reset}` : text;
const green = color(32);
const red = color(31);
const dim = color(2);
const cyan = color(36);

const CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".obj": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function ink(projectDir: string, config?: ProjectConfig): Plugin {
  const ready = resolveProject(projectDir, config);
  let host: InkHost | undefined;

  return {
    name: "ink",
    enforce: "pre",
    async config() {
      const p = await ready;
      return {
        server: {
          fs: { allow: allowedDirs(p) },
          watch: {
            ignored: ["**/.ink/captures/**", "**/.ink/handoffs/**"],
          },
        },
        // The dev client and engine packages are workspace sources, not deps.
        // React is declared up front: discovering it on first load makes Vite
        // re-optimize mid-load and fail requests with 504 "Outdated Optimize Dep".
        optimizeDeps: {
          exclude: ["@ink/dev", "@ink/schema", "@ink/blot"],
          include: [
            "react",
            "react-dom",
            "react-dom/client",
            "react/jsx-runtime",
            "react/jsx-dev-runtime",
          ],
        },
      };
    },
    resolveId(id) {
      if (id.startsWith("@ink/") || id.startsWith("@mewhhaha/blot")) {
        try {
          const url = import.meta.resolve(id);
          if (url.startsWith("file:")) return fileURLToPath(url);
        } catch {
          // fall through to normal resolution
        }
      }
      return null;
    },
    async configureServer(server) {
      host = new InkHost(await ready, server);
      await host.start();
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/__ink/")) return next();
        host!.handle(req, res).catch(next);
      });
      server.httpServer?.once("close", () => void host?.dispose());
    },
    handleHotUpdate(ctx) {
      // Everything Ink watches is delivered as an ink:* event, never as a reload.
      if (host?.owns(ctx.file)) return [];
    },
  };
}

type Emit = <K extends keyof DevEvents>(event: K, data: DevEvents[K]) => void;

export class InkHost {
  #schema: Schema | null = null;
  #schemaVersion = 0;
  #catalog: Catalog = { assets: {} };
  #compiler: GameCompiler | null = null;
  #game: GameInfo | null = null;
  #diagnostics: DevDiagnostic[] = [];
  #wasm = new Map<number, Uint8Array>();
  #revision = 0;
  #scenes = new Set<string>();
  #selfWrites = new Map<string, string>();
  #dirty = { schema: false, assets: false, blot: false };
  #timer: ReturnType<typeof setTimeout> | undefined;
  #flushing: Promise<void> = Promise.resolve();
  #disposed = false;

  constructor(
    readonly project: ResolvedProject,
    readonly server: ViteDevServer,
  ) {}

  get #commentsPath() {
    return join(this.project.inkDir, "comments.json");
  }

  emit: Emit = (event, data) => {
    this.server.ws.send({ type: "custom", event, data });
  };

  info(): ProjectInfo {
    return {
      title: this.project.title,
      catalog: this.#catalog,
      scenes: [...this.#scenes].sort(),
      game: this.#game,
      diagnostics: this.#diagnostics,
      schemaUrl: this.#schema
        ? `/@fs${this.project.schemaPath}?ink=${this.#schemaVersion}`
        : null,
    };
  }

  owns(file: string): boolean {
    const p = this.project;
    const f = resolve(file);
    return f === p.schemaPath || f.endsWith(".blot") ||
      f.startsWith(p.scenesDir + sep) || f.startsWith(p.assetsDir + sep) ||
      f.startsWith(p.inkDir + sep);
  }

  async start() {
    const p = this.project;
    await this.#rescanScenes();
    this.#catalog = await scanAssets(p.assetsDir);
    try {
      if (await exists(p.schemaPath)) {
        this.#schema = await loadSchema(p.schemaPath, ++this.#schemaVersion);
      }
    } catch (error) {
      this.#diagnostics = [schemaDiagnostic(p, error)];
      this.#logSchemaError(error);
    }
    if (this.#schema && await exists(p.gamePath)) {
      this.#compiler = await createGameCompiler({
        entry: p.gamePath,
        schema: this.#schema,
        catalog: this.#catalog,
      });
      await this.#build(false);
    }
    const watcher = this.server.watcher;
    watcher.add([p.schemaPath, dirname(p.gamePath), p.scenesDir, p.assetsDir]);
    watcher.add(this.#commentsPath);
    for (const event of ["add", "change", "unlink"] as const) {
      watcher.on(event, (file) => this.#onFile(event, resolve(file)));
    }
  }

  async dispose() {
    this.#disposed = true;
    clearTimeout(this.#timer);
    await this.#flushing;
    await this.#compiler?.dispose();
  }

  // ---- watching -----------------------------------------------------------

  #onFile(event: "add" | "change" | "unlink", file: string) {
    const p = this.project;
    if (file === p.schemaPath) return this.#schedule({ schema: true });
    if (file === this.#commentsPath) {
      return void this.#externalJson(file, () => this.emit("ink:comments", {}));
    }
    if (
      file.endsWith(".blot") && !file.endsWith(".gen.blot") &&
      file.startsWith(dirname(p.gamePath) + sep)
    ) {
      return this.#schedule({ blot: true });
    }
    if (file.startsWith(p.scenesDir + sep) && file.endsWith(".scene.json")) {
      const name = file.slice(p.scenesDir.length + 1, -".scene.json".length);
      if (name.includes(sep)) return;
      if (event === "unlink") {
        this.#scenes.delete(name);
        this.#selfWrites.delete(file);
        return this.emit("ink:scene", { name, removed: true });
      }
      this.#scenes.add(name);
      return void this.#externalJson(
        file,
        () => this.emit("ink:scene", { name }),
      );
    }
    if (file.startsWith(p.assetsDir + sep)) {
      const path = relative(p.assetsDir, file).split(sep).join("/");
      const kind = assetKind(path);
      if (!kind || path.split("/").some((s) => s.startsWith("."))) return;
      if (event === "change") return this.emit("ink:asset", { kind, path });
      return this.#schedule({ assets: true });
    }
  }

  /** Run `then` unless the file's content is what this process just wrote. */
  async #externalJson(file: string, then: () => void) {
    try {
      const text = await Deno.readTextFile(file);
      if (this.#selfWrites.get(file) === text) return;
    } catch {
      // vanished again; treat as a change
    }
    then();
  }

  #schedule(
    flags: Partial<{ schema: boolean; assets: boolean; blot: boolean }>,
  ) {
    Object.assign(
      this.#dirty,
      Object.fromEntries(Object.keys(flags).map((k) => [k, true])),
    );
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#flushing = this.#flushing.then(() => this.#flush());
    }, 12);
  }

  async #flush() {
    while (
      !this.#disposed &&
      (this.#dirty.schema || this.#dirty.assets || this.#dirty.blot)
    ) {
      const dirty = this.#dirty;
      this.#dirty = { schema: false, assets: false, blot: false };
      try {
        await this.#apply(dirty);
      } catch (error) {
        console.error(red(`ink: ${String(error)}`));
      }
    }
  }

  async #apply(dirty: { schema: boolean; assets: boolean; blot: boolean }) {
    const p = this.project;
    let projectChanged = false;
    let schemaError = false;
    if (dirty.schema) {
      try {
        if (await exists(p.schemaPath)) {
          this.#schema = await loadSchema(p.schemaPath, ++this.#schemaVersion);
          projectChanged = true;
        }
      } catch (error) {
        schemaError = true;
        this.#diagnostics = [schemaDiagnostic(p, error)];
        this.#logSchemaError(error);
        this.emit("ink:diagnostics", { diagnostics: this.#diagnostics, ms: 0 });
      }
    }
    if (dirty.assets) {
      const next = await scanAssets(p.assetsDir);
      if (JSON.stringify(next) !== JSON.stringify(this.#catalog)) {
        this.#catalog = next;
        projectChanged = true;
      }
    }
    if (!this.#schema) return;
    if (!this.#compiler) {
      if (!(await exists(p.gamePath))) return;
      this.#compiler = await createGameCompiler({
        entry: p.gamePath,
        schema: this.#schema,
        catalog: this.#catalog,
      });
      projectChanged = true;
    } else if (projectChanged) {
      await this.#compiler.generate(this.#schema, this.#catalog);
    }
    if (projectChanged) this.emit("ink:project", this.info());
    if (schemaError && !projectChanged && !dirty.blot) return;
    if (projectChanged || dirty.blot) await this.#build(true);
  }

  async #build(announce: boolean) {
    const compiler = this.#compiler;
    if (!compiler) return;
    const result = await compiler.build();
    const ms = Math.round(result.ms);
    if (result.ok) {
      const revision = ++this.#revision;
      this.#wasm.set(revision, result.bytes);
      for (const old of [...this.#wasm.keys()]) {
        if (old <= revision - KEEP_REVISIONS) this.#wasm.delete(old);
      }
      this.#game = { revision, url: `/__ink/game/${revision}.wasm`, ms };
      this.#diagnostics = [];
      console.log(
        `${cyan("blot")} ${green("✓")} ${ms}ms ${dim(`rev ${revision}`)}`,
      );
      if (announce) this.emit("ink:game", this.#game);
    } else {
      this.#diagnostics = result.diagnostics.map((d) => this.#diagnostic(d));
      console.log(
        `${cyan("blot")} ${red("✗")} ${ms}ms ${
          dim(`${this.#diagnostics.length} error(s)`)
        }`,
      );
      for (const d of this.#diagnostics) {
        console.log(
          `  ${red(`${d.file}:${d.line}:${d.column}`)} ${d.code}: ${d.message}`,
        );
        if (d.excerpt) console.log(`    ${dim(d.excerpt.trim())}`);
      }
      if (announce) {
        this.emit("ink:diagnostics", { diagnostics: this.#diagnostics, ms });
      }
    }
  }

  #diagnostic(d: Diagnostic): DevDiagnostic {
    return { ...d, file: this.#relative(d.file) };
  }

  #relative(file: string) {
    const rel = relative(this.project.dir, file);
    return rel.startsWith("..") ? file : rel;
  }

  #logSchemaError(error: unknown) {
    console.log(
      `${cyan("schema")} ${red("✗")} ${
        String(error instanceof Error ? error.message : error)
      }`,
    );
  }

  async #rescanScenes() {
    this.#scenes.clear();
    try {
      for await (const entry of Deno.readDir(this.project.scenesDir)) {
        if (entry.isFile && entry.name.endsWith(".scene.json")) {
          this.#scenes.add(entry.name.slice(0, -".scene.json".length));
        }
      }
    } catch {
      // no scenes directory yet
    }
  }

  // ---- HTTP ---------------------------------------------------------------

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await this.#route(req, res);
    } catch (error) {
      if (error instanceof HttpError) {
        return json(res, error.status, { error: error.message });
      }
      if (error instanceof PathError) {
        return json(res, 400, { error: error.message });
      }
      if (error instanceof Deno.errors.NotFound) {
        return json(res, 404, { error: "not found" });
      }
      json(res, 500, { error: String(error) });
    }
  }

  async #route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url!, "http://ink");
    const path = url.pathname.slice("/__ink/".length);
    const method = req.method ?? "GET";
    const [head, ...rest] = path.split("/");
    const tail = rest.join("/");
    const p = this.project;
    const only = (...methods: string[]) => {
      if (!methods.includes(method)) {
        throw new HttpError(405, `${method} not allowed`);
      }
    };

    switch (head) {
      case "project":
        only("GET");
        return json(res, 200, this.info());
      case "game": {
        only("GET");
        const m = /^(\d+)\.wasm$/.exec(tail);
        const bytes = m && this.#wasm.get(Number(m[1]));
        if (!bytes) throw new HttpError(404, "unknown or expired revision");
        res.setHeader("Content-Type", "application/wasm");
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        return void res.end(bytes);
      }
      case "assets": {
        only("GET");
        return await sendFile(
          res,
          resolveInside(p.assetsDir, tail),
          "no-cache",
        );
      }
      case "scenes": {
        if (tail === "") {
          only("GET");
          return json(res, 200, [...this.#scenes].sort());
        }
        const file = join(p.scenesDir, `${checkName(tail)}.scene.json`);
        if (method === "GET") return await sendFile(res, file, "no-cache");
        only("PUT");
        const body = await readJson(req);
        if (!isObject(body) || !Array.isArray(body.entities)) {
          throw new HttpError(
            400,
            "a scene is an object with an entities array",
          );
        }
        await this.#writeOwn(file, stableJson(body));
        this.#scenes.add(tail);
        return json(res, 200, { ok: true });
      }
      case "comments": {
        if (tail !== "") throw new HttpError(404, "not found");
        if (method === "GET") {
          try {
            return await sendFile(res, this.#commentsPath, "no-cache");
          } catch {
            return json(res, 200, []);
          }
        }
        only("PUT");
        const body = await readJson(req);
        if (!Array.isArray(body)) {
          throw new HttpError(400, "comments are an array");
        }
        await this.#writeOwn(this.#commentsPath, stableJson(body));
        return json(res, 200, { ok: true });
      }
      case "handoffs":
      case "captures": {
        const root = join(p.inkDir, head);
        if (tail === "") {
          if (method === "POST") {
            const body = await readJson(req);
            return json(res, 200, await this.#writeBundle(root, body));
          }
          only("GET");
          return json(res, 200, await listDirs(root));
        }
        only("GET");
        const [id, ...file] = tail.split("/");
        checkName(decodeURIComponent(id));
        if (file.length === 0) {
          return json(
            res,
            200,
            await listFiles(join(root, decodeURIComponent(id))),
          );
        }
        return await sendFile(
          res,
          resolveInside(join(root, id), file.join("/")),
          "no-cache",
        );
      }
      default:
        throw new HttpError(404, "not found");
    }
  }

  async #writeOwn(file: string, text: string) {
    this.#selfWrites.set(file, text);
    await Deno.mkdir(dirname(file), { recursive: true });
    await Deno.writeTextFile(file, text);
  }

  async #writeBundle(
    root: string,
    body: unknown,
  ): Promise<BundleResult> {
    if (!isObject(body) || !Array.isArray(body.files)) {
      throw new HttpError(
        400,
        "expected { id?, files: [{ name, text | base64 }] }",
      );
    }
    const request = body as unknown as BundleRequest;
    const id = request.id === undefined ? makeId() : checkName(request.id);
    const dir = join(root, id);
    const writes = request.files.map((f) => {
      if (!isObject(f) || typeof f.name !== "string") {
        throw new HttpError(400, "each file needs a name");
      }
      const target = resolveInside(dir, f.name);
      if (typeof f.text === "string") {
        return [target, new TextEncoder().encode(f.text)] as const;
      }
      if (typeof f.base64 === "string") {
        return [
          target,
          Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0)),
        ] as const;
      }
      throw new HttpError(400, `file ${f.name} needs text or base64`);
    });
    for (const [target, bytes] of writes) {
      await Deno.mkdir(dirname(target), { recursive: true });
      await Deno.writeFile(target, bytes);
    }
    await Deno.mkdir(dir, { recursive: true });
    return { id, dir: relative(this.project.dir, dir).split(sep).join("/") };
  }
}

function schemaDiagnostic(p: ResolvedProject, error: unknown): DevDiagnostic {
  const message = error instanceof Error ? error.message : String(error);
  return {
    file: relative(p.dir, p.schemaPath),
    line: 1,
    column: 1,
    code: error instanceof Error && error.name ? error.name : "schema_error",
    message,
    excerpt: "",
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-cache");
  res.end(JSON.stringify(body));
}

async function sendFile(res: ServerResponse, file: string, cache: string) {
  const bytes = await Deno.readFile(file);
  res.setHeader(
    "Content-Type",
    CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
  );
  res.setHeader("Cache-Control", cache);
  res.end(bytes);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 128 * 1024 * 1024) throw new HttpError(413, "body too large");
    chunks.push(chunk);
  }
  const text = new TextDecoder().decode(
    await new Blob(chunks as BlobPart[]).arrayBuffer(),
  );
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

async function listDirs(root: string): Promise<string[]> {
  try {
    const names: string[] = [];
    for await (const e of Deno.readDir(root)) {
      if (e.isDirectory) names.push(e.name);
    }
    return names.sort();
  } catch {
    return [];
  }
}

async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const names: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    if (e.isDirectory) {
      names.push(...await listFiles(join(dir, e.name), `${prefix}${e.name}/`));
    } else names.push(prefix + e.name);
  }
  return names.sort();
}
