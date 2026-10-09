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
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { LiveHost, validLiveOrigin } from "./live_host.ts";
import { MultiplayerHost } from "./multiplayer_host.ts";
import { SharedHost } from "./shared_host.ts";
import { liveObject, liveString } from "./live.ts";
import {
  dirname,
  extname,
  join,
  relative,
  resolve,
  SEPARATOR as sep,
} from "@std/path";
import type { Plugin, ViteDevServer } from "vite";
import type { Catalog, SceneFile, Schema } from "@ink/schema";
import {
  createGameCompiler,
  type Diagnostic,
  type GameCompiler,
} from "@ink/blot/compiler";
import type { ProjectConfig } from "./project.ts";
import type {
  AssetEvent,
  BundleRequest,
  BundleResult,
  ChangeTrace,
  DevDiagnostic,
  DevEvents,
  GameInfo,
  ProjectInfo,
} from "./protocol.ts";
import { assetKind, scanAssets } from "./catalog.ts";
import { HttpFailure, ImportHost } from "./imports.ts";
import {
  ASSET_WRITE_EXTENSIONS,
  AssetWriteError,
  AssetWrites,
  readBody,
} from "./asset_write.ts";
import { listScenarios, loadScenario } from "./scenarios.ts";
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
/** Scene files smaller than this are sent inside the `ink:scene` event. */
/** Compiled games up to this size travel inside the `ink:game` event. */
const INLINE_GAME_BYTES = 8 * 1024 * 1024;
const INLINE_SCENE_BYTES = 256 * 1024;

/** Epoch milliseconds; the page's profiler reads the same clock. */
const epochNow = () => performance.timeOrigin + performance.now();

/** A file change the server is acting on, for save-to-pixels traces. */
interface Cause {
  id: string;
  kind: ChangeTrace["kind"];
  file: string;
  written: Promise<number | null>;
  detected: number;
}

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
          exclude: [
            "@ink/dev",
            "@ink/schema",
            "@ink/blot",
            "@ink/core",
            "@ink/geometry",
            "@ink/render",
            "@ink/react",
            "@ink/brushes",
            "@ink/tiles",
            "@ink/terrain",
            "@ink/player",
          ],
          include: [
            "react",
            "react-dom",
            "react-dom/client",
            "react/jsx-runtime",
            "react/jsx-dev-runtime",
            // The renderer reads meshopt-compressed glTF buffers.
            "meshoptimizer/decoder",
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
      server.httpServer?.once(
        "close",
        () => void host?.dispose().catch((error) => console.error(error)),
      );
    },
    async closeBundle() {
      await host?.dispose();
    },
    handleHotUpdate(ctx) {
      // Everything Ink watches is delivered as an ink:* event, never as a reload.
      if (host?.owns(ctx.file)) return [];
    },
  };
}

type Emit = <K extends keyof DevEvents>(event: K, data: DevEvents[K]) => void;

function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

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
  #cause: Cause | null = null;
  #assetCauses = new Map<string, Cause>();
  #sceneTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Schema layout and asset catalog the running module was built against. */
  #builtLayout = "";
  #schemaKey = "";
  #sourcesBuilt = "";
  #timer: ReturnType<typeof setTimeout> | undefined;
  #flushing: Promise<void> = Promise.resolve();
  #disposed = false;
  #disposal?: Promise<void>;
  #imports: ImportHost;
  #assetWrites: AssetWrites;
  #live: LiveHost;
  #multiplayer: MultiplayerHost;
  #shared: SharedHost;

  constructor(
    readonly project: ResolvedProject,
    readonly server: ViteDevServer,
  ) {
    this.#imports = new ImportHost(
      project,
      (event, data) => {
        // The importer announces a reload once its result exists; give that
        // event the trace of the file change that caused it.
        const asset = event === "ink:asset" ? data as AssetEvent : undefined;
        const cause = asset && this.#assetCauses.get(asset.path);
        if (asset && cause) {
          this.#assetCauses.delete(asset.path);
          void this.#emitWith(
            cause,
            (trace) => this.emit("ink:asset", { ...asset, trace }),
          );
        } else this.emit(event, data as never);
      },
      (line) => console.log(`${cyan("assets")} ${dim(line)}`),
    );
    this.#assetWrites = new AssetWrites(project.assetsDir);
    this.#live = new LiveHost(server, project.dir);
    this.#multiplayer = new MultiplayerHost(server);
    this.#shared = new SharedHost(
      server,
      project,
      (file, text) => this.#writeOwn(file, text),
    );
  }

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
    await this.#imports.start();
    watcher.add(this.#commentsPath);
    for (const event of ["add", "change", "unlink"] as const) {
      watcher.on(event, (file) => this.#onFile(event, resolve(file)));
    }
  }

  dispose() {
    return this.#disposal ??= this.#dispose();
  }

  async #dispose() {
    this.#disposed = true;
    this.#imports.dispose();
    this.#live.dispose();
    this.#multiplayer.dispose();
    await this.#shared.dispose();
    clearTimeout(this.#timer);
    for (const timer of this.#sceneTimers.values()) clearTimeout(timer);
    await this.#flushing;
    await this.#compiler?.dispose();
  }

  // ---- watching -----------------------------------------------------------

  #onFile(
    event: "add" | "change" | "unlink",
    file: string,
    /** The change is known not to be one of our own asset writes. */
    checked = false,
  ) {
    const p = this.project;
    if (file === p.schemaPath) {
      return this.#schedule({ schema: true }, this.#causeOf("schema", file));
    }
    if (file === this.#commentsPath) {
      return void this.#externalJson(file, () => {
        if (this.#shared.activeScene) {
          void Deno.readTextFile(file).then(JSON.parse).then((comments) =>
            this.#shared.external(undefined, comments)
          ).catch((error) => console.error("shared comments:", error));
        }
        this.emit("ink:comments", {});
      });
    }
    if (
      file.endsWith(".blot") && !file.endsWith(".gen.blot") &&
      file.startsWith(dirname(p.gamePath) + sep)
    ) {
      return this.#schedule({ blot: true }, this.#causeOf("code", file));
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
      // An editor saves by truncating and then writing: wait for the write.
      const cause = this.#causeOf("scene", file);
      clearTimeout(this.#sceneTimers.get(file));
      this.#sceneTimers.set(
        file,
        setTimeout(() => {
          this.#sceneTimers.delete(file);
          void this.#sceneChanged(file, name, cause);
        }, 4),
      );
      return;
    }
    if (file.startsWith(p.assetsDir + sep)) {
      // The tools write terrain and scatter files in place; the editor that
      // made the change already shows it, so reloading would only discard it.
      if (
        !checked && event === "change" &&
        ASSET_WRITE_EXTENSIONS.includes(extname(file).toLowerCase())
      ) {
        return void this.#assetWrites.isOwnChange(file).then((own) => {
          if (!own && !this.#disposed) this.#onFile(event, file, true);
        });
      }
      const path = relative(p.assetsDir, file).split(sep).join("/");
      const kind = assetKind(path);
      if (!kind || path.split("/").some((s) => s.startsWith("."))) {
        // Not an asset itself, but a model may read it (buffers, images).
        this.#imports.file(event, file);
        return;
      }
      // Imported assets announce themselves once a result is ready.
      if (event === "change") {
        this.#assetCauses.set(path, this.#causeOf("asset", file));
      }
      const imported = this.#imports.file(event, file);
      if (event === "change" && imported) return;
      this.#assetCauses.delete(path);
      if (event === "change") {
        void this.#emitWith(
          this.#causeOf("asset", file),
          (trace) => this.emit("ink:asset", { kind, path, trace }),
        );
        // An atlas names the frames Blot sees; rescan to regenerate them.
        if (kind === "atlas") this.#schedule({ assets: true });
        return;
      }
      return this.#schedule(
        { assets: true },
        this.#causeOf("asset", file),
      );
    }
  }

  #causeOf(kind: Cause["kind"], file: string): Cause {
    return {
      id: crypto.randomUUID(),
      kind,
      file: this.#relative(file),
      detected: epochNow(),
      written: Deno.stat(file).then(
        (info) => info.mtime?.getTime() ?? null,
        () => null,
      ),
    };
  }

  /** Resolve a cause into a trace stamped now and hand it to `send`. */
  async #emitWith(cause: Cause, send: (trace: ChangeTrace) => void) {
    send(await this.#traceOf(cause));
  }

  async #traceOf(
    cause: Cause,
    extra: Partial<ChangeTrace> = {},
  ): Promise<ChangeTrace> {
    return {
      id: cause.id,
      kind: cause.kind,
      file: cause.file,
      written: await cause.written,
      detected: cause.detected,
      emitted: epochNow(),
      ...extra,
    };
  }

  async #sceneChanged(file: string, name: string, cause: Cause) {
    let text: string | undefined;
    let scene: SceneFile | undefined;
    // A save that is still in flight reads as an empty or cut-off file.
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        text = await Deno.readTextFile(file);
      } catch {
        text = undefined;
        break;
      }
      if (this.#selfWrites.get(file) === text) return;
      try {
        scene = JSON.parse(text);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 8));
      }
    }
    if (this.#shared.activeScene === name) {
      void Deno.readTextFile(file).then(JSON.parse).then((scene) =>
        this.#shared.external(scene)
      ).catch((error) => console.error("shared scene:", error));
    }
    // Small scenes travel with the event: no second request to wait for.
    if (text !== undefined && text.length >= INLINE_SCENE_BYTES) {
      scene = undefined;
    }
    void this.#emitWith(
      cause,
      (trace) => this.emit("ink:scene", { name, trace, scene }),
    );
  }

  /** Run `then` unless the file's content is what this process just wrote. */
  async #externalJson(file: string, then: (text?: string) => void) {
    let text: string | undefined;
    try {
      text = await Deno.readTextFile(file);
      if (this.#selfWrites.get(file) === text) return;
    } catch {
      // vanished again; treat as a change
    }
    then(text);
  }

  #schedule(
    flags: Partial<{ schema: boolean; assets: boolean; blot: boolean }>,
    cause?: Cause,
  ) {
    if (cause) this.#cause = cause;
    Object.assign(
      this.#dirty,
      Object.fromEntries(Object.keys(flags).map((k) => [k, true])),
    );
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#flushing = this.#flushing.then(() => this.#flush());
    }, 5);
  }

  async #flush() {
    while (
      !this.#disposed &&
      (this.#dirty.schema || this.#dirty.assets || this.#dirty.blot)
    ) {
      const dirty = this.#dirty;
      const cause = this.#cause;
      this.#dirty = { schema: false, assets: false, blot: false };
      this.#cause = null;
      try {
        await this.#apply(dirty, cause);
      } catch (error) {
        console.error(red(`ink: ${String(error)}`));
      }
    }
  }

  async #apply(
    dirty: { schema: boolean; assets: boolean; blot: boolean },
    cause: Cause | null = null,
  ) {
    const started = epochNow();
    const p = this.project;
    let projectChanged = false;
    let schemaError = false;
    if (dirty.schema) {
      try {
        if (await exists(p.schemaPath)) {
          const next = await loadSchema(p.schemaPath, ++this.#schemaVersion);
          // A save that left the schema as it was (a second file event, a
          // touch) changes nothing downstream.
          const key = JSON.stringify(next);
          projectChanged = key !== this.#schemaKey || !this.#schema;
          this.#schemaKey = key;
          this.#schema = next;
        }
      } catch (error) {
        schemaError = true;
        this.#diagnostics = [schemaDiagnostic(p, error)];
        this.#logSchemaError(error);
        this.emit("ink:diagnostics", { diagnostics: this.#diagnostics, ms: 0 });
      }
    }
    if (dirty.assets) {
      const next = await scanAssets(p.assetsDir, this.#catalog);
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
    if (projectChanged) {
      this.emit("ink:project", {
        ...this.info(),
        trace: cause ? await this.#traceOf(cause, { started }) : undefined,
      });
    }
    if (schemaError && !projectChanged && !dirty.blot) return;
    let sourcesChanged = projectChanged;
    if (dirty.blot) {
      const key = await this.#sourcesKey();
      sourcesChanged ||= key !== this.#sourcesBuilt;
      this.#sourcesBuilt = key;
    }
    if (sourcesChanged) {
      await this.#build(
        true,
        cause,
        started,
        this.#layoutKey() !== this.#builtLayout,
      );
    }
  }

  /** The game directory's Blot sources, to tell a real edit from a repeated
   * file event. */
  async #sourcesKey() {
    const dir = dirname(this.project.gamePath);
    const parts: string[] = [];
    try {
      const names: string[] = [];
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isFile && entry.name.endsWith(".blot")) {
          names.push(entry.name);
        }
      }
      for (const name of names.sort()) {
        parts.push(name, await Deno.readTextFile(join(dir, name)));
      }
    } catch {
      return `${Math.random()}`;
    }
    return parts.join("\0");
  }

  #layoutKey() {
    return `${this.#schema?.hash}:${JSON.stringify(this.#catalog)}`;
  }

  async #build(
    announce: boolean,
    cause: Cause | null = null,
    started = epochNow(),
    force = true,
  ) {
    const compiler = this.#compiler;
    if (!compiler) return;
    const result = await compiler.build();
    const compiled = epochNow();
    const ms = Math.round(result.ms);
    if (result.ok) {
      const previous = this.#wasm.get(this.#revision);
      if (!force && previous && sameBytes(previous, result.bytes)) {
        // Comments, whitespace or a change the optimizer erased: the running
        // game is already right, so skip the transfer and the swap.
        console.log(
          `${cyan("blot")} ${green("✓")} ${ms}ms ${
            dim(`unchanged, rev ${this.#revision}`)
          }`,
        );
        if (announce && this.#game) {
          this.emit("ink:game", {
            ...this.#game,
            unchanged: true,
            trace: cause
              ? await this.#traceOf(cause, { started, compiled })
              : undefined,
          });
        }
        return;
      }
      this.#builtLayout = this.#layoutKey();
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
      if (announce) {
        this.emit("ink:game", {
          ...this.#game,
          // Inline bytes spare the page a request while it waits for them.
          bytes: result.bytes.length <= INLINE_GAME_BYTES
            ? Buffer.from(result.bytes).toString("base64")
            : undefined,
          trace: cause
            ? await this.#traceOf(cause, {
              started,
              compiled,
              compile: {
                ms: result.ms,
                bytes: result.bytes.length,
                ...result.stats,
              },
            })
            : undefined,
        });
      }
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
        this.emit("ink:diagnostics", {
          diagnostics: this.#diagnostics,
          ms,
          trace: cause
            ? await this.#traceOf(cause, { started, compiled })
            : undefined,
        });
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
      if (error instanceof HttpError || error instanceof HttpFailure) {
        return json(res, error.status, { error: error.message });
      }
      if (error instanceof AssetWriteError) {
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
      case "mcp":
      case "live": {
        if (!validLiveOrigin(req)) {
          throw new HttpError(403, "origin is not allowed");
        }
        if (head === "live" && tail === "sessions") {
          only("GET");
          return json(res, 200, this.#live.list());
        }
        only("POST");
        const version = req.headers["mcp-protocol-version"];
        if (
          head === "mcp" && version && version !== "2025-11-25" &&
          version !== "2025-06-18"
        ) {
          throw new HttpError(400, "unsupported MCP protocol version");
        }
        try {
          const body = await readJson(req);
          if (head === "mcp") {
            const result = await this.#live.mcp(body);
            if (result === null) {
              res.statusCode = 202;
              res.end();
              return;
            }
            return json(res, 200, result);
          }
          if (tail !== "call") throw new HttpError(404, "not found");
          const call = liveObject(body);
          const params = call.params === undefined
            ? {}
            : liveObject(call.params);
          return json(
            res,
            200,
            await this.#live.call(liveString(call.method, "method"), {
              ...params,
              ...(call.session ? { session: call.session } : {}),
            }),
          );
        } catch (error) {
          if (error instanceof HttpError) throw error;
          throw new HttpError(
            400,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      case "scenarios":
        only("GET");
        return json(
          res,
          200,
          tail ? await loadScenario(p, tail) : await listScenarios(p),
        );
      case "scenario-files":
        only("GET");
        return await sendFile(
          res,
          resolveInside(join(p.dir, "scenarios"), tail),
          "no-cache",
        );
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
      case "assets":
        only("GET");
        return await this.#imports.asset(req, res, tail);
      case "assets-write": {
        if (!validLiveOrigin(req)) {
          throw new HttpError(403, "origin is not allowed");
        }
        only("PUT", "PATCH");
        const body = await readBody(req);
        return json(
          res,
          200,
          await this.#assetWrites.handle(method, tail, url.searchParams, body),
        );
      }
      case "imports":
        only("GET");
        return json(res, 200, this.#imports.statuses());
      case "thumbs":
        only("GET", "PUT");
        return await this.#imports.thumbnail(req, res, tail, url.searchParams);
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
        if (this.#shared.activeScene === tail) {
          await this.#shared.external(
            body as unknown as import("@ink/schema").SceneFile,
          );
        }
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
        if (this.#shared.activeScene) {
          throw new HttpError(
            409,
            "Comments are shared; edit them through a connected session",
          );
        }
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
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      await Deno.writeTextFile(temporary, text);
      await Deno.rename(temporary, file);
    } finally {
      await Deno.remove(temporary).catch(() => {});
    }
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
