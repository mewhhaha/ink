/**
 * Import on save for the dev server: owns the `AssetImporter`, decides what
 * `/__ink/assets/...` serves (the imported result when there is one, the
 * source otherwise), reports progress, and stores thumbnails the editor
 * renders.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, relative, SEPARATOR as sep } from "@std/path";
import { AssetImporter, type ImportStatus } from "@ink/assets";
import { assetKind } from "./catalog.ts";
import type { AssetEvent, ImportsEvent } from "./protocol.ts";
import { resolveInside } from "./paths.ts";
import type { ResolvedProject } from "./node.ts";

const CONTENT_TYPES: Record<string, string> = {
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
};

class HttpFailure extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

type EmitImports = {
  (event: "ink:imports", data: ImportsEvent): void;
  (event: "ink:asset", data: AssetEvent): void;
};

export class ImportHost {
  readonly importer: AssetImporter;
  #emit: EmitImports;
  #pending = new Map<string, ImportStatus>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #seen = new Map<string, string>();
  #disposed = false;

  constructor(
    private project: ResolvedProject,
    emit: EmitImports,
    log: (line: string) => void,
  ) {
    this.#emit = emit;
    this.importer = new AssetImporter({
      assetsDir: project.assetsDir,
      cacheDir: join(project.inkDir, "cache"),
      settings: project.config.import,
      log,
      onStatus: (status) => this.#status(status),
    });
  }

  /** Register everything under assets/; imports run in the background. */
  async start() {
    await this.importer.scan();
    // Entries not used by the current assets and untouched for two weeks.
    void this.importer.idle().then(() => this.importer.collectGarbage());
  }

  dispose() {
    this.#disposed = true;
    clearTimeout(this.#timer);
    this.importer.dispose();
  }

  statuses(): ImportStatus[] {
    return this.importer.statuses();
  }

  /** A file under assets/ changed. Returns true when the importer owns the
   * reload notification (the editor is told once a result is ready). */
  file(event: "add" | "change" | "unlink", file: string): boolean {
    const path = relative(this.project.assetsDir, file).split(sep).join("/");
    if (path.split("/").some((s) => s.startsWith("."))) return false;
    if (event === "unlink") this.importer.remove(path);
    else this.importer.update(path);
    return event !== "unlink" && !!this.importer.status(path);
  }

  #status(status: ImportStatus) {
    if (this.#disposed) return;
    // Tell editors to reload an asset whenever a result becomes available.
    const signature = `${status.state}|${
      status.done.join(",")
    }|${status.source}`;
    const kind = assetKind(status.path);
    if (
      kind &&
      this.#seen.get(status.path) !== signature &&
      (status.state === "skipped" || status.state === "failed" ||
        status.done.length > 0)
    ) {
      this.#seen.set(status.path, signature);
      this.#emit("ink:asset", { kind, path: status.path });
    }
    this.#pending.set(status.path, status);
    this.#timer ??= setTimeout(() => {
      this.#timer = undefined;
      const statuses = [...this.#pending.values()];
      this.#pending.clear();
      this.#emit("ink:imports", { statuses });
    }, 80);
  }

  // ---- HTTP ------------------------------------------------------------------

  /** `GET /__ink/assets/<path>`: the best imported result or the source. */
  async asset(req: IncomingMessage, res: ServerResponse, tail: string) {
    const file = resolveInside(this.project.assetsDir, tail);
    const path = relative(this.project.assetsDir, file).split(sep).join("/");
    let output = this.importer.output(path);
    if (!output) {
      const status = this.importer.status(path);
      if (status?.state === "queued" || status?.state === "importing") {
        // First sight of a large asset: its quick preview beats the raw file.
        await this.importer.wait(path, "preview", 20_000);
        output = this.importer.output(path);
      }
    }
    res.setHeader("Cache-Control", "no-cache");
    if (output) {
      const etag = `"${output.key}"`;
      res.setHeader("ETag", etag);
      res.setHeader("Content-Type", output.type);
      res.setHeader("X-Ink-Import", output.stage);
      if (req.headers["if-none-match"] === etag) {
        res.statusCode = 304;
        return void res.end();
      }
      return void res.end(await Deno.readFile(output.file));
    }
    const info = await Deno.stat(file);
    const etag = `W/"${info.size}-${info.mtime?.getTime() ?? 0}"`;
    res.setHeader("ETag", etag);
    res.setHeader(
      "Content-Type",
      CONTENT_TYPES[file.slice(file.lastIndexOf(".")).toLowerCase()] ??
        "application/octet-stream",
    );
    if (req.headers["if-none-match"] === etag) {
      res.statusCode = 304;
      return void res.end();
    }
    res.end(await Deno.readFile(file));
  }

  /** `GET|PUT /__ink/thumbs/<asset path>?variant=<name>[&source=<hash>]`. */
  async thumbnail(
    req: IncomingMessage,
    res: ServerResponse,
    tail: string,
    query: URLSearchParams,
  ) {
    const file = resolveInside(this.project.assetsDir, tail);
    const path = relative(this.project.assetsDir, file).split(sep).join("/");
    const variant = query.get("variant") ?? "asset";
    if (!/^[A-Za-z0-9:_.-]{1,40}$/.test(variant)) {
      throw new HttpFailure(400, "bad thumbnail variant");
    }
    if (req.method === "PUT") {
      const source = query.get("source") ?? "";
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) {
          throw new HttpFailure(413, "thumbnail too large");
        }
        chunks.push(chunk);
      }
      const png = new Uint8Array(size);
      let at = 0;
      for (const c of chunks) {
        png.set(c, at);
        at += c.length;
      }
      if (png[0] !== 0x89 || png[1] !== 0x50) {
        throw new HttpFailure(400, "thumbnails are PNG files");
      }
      const stored = await this.importer.storeThumbnail(
        path,
        variant,
        source,
        png,
      );
      res.statusCode = stored ? 200 : 409;
      res.setHeader("Content-Type", "application/json");
      return void res.end(JSON.stringify({ ok: stored }));
    }
    const found = await this.importer.thumbnail(path, variant);
    if (!found) {
      // Not an error: the editor asks before it has drawn one.
      res.statusCode = 204;
      return void res.end();
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-cache");
    const etag = `"${found.split(sep).at(-2)}"`;
    res.setHeader("ETag", etag);
    if (req.headers["if-none-match"] === etag) {
      res.statusCode = 304;
      return void res.end();
    }
    res.end(await Deno.readFile(found));
  }
}

export { HttpFailure };
