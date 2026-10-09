/**
 * Import on save. `AssetImporter` watches nothing itself: the dev server tells
 * it about files (`scan`, `update`, `remove`) and asks what to serve
 * (`resolve`). Work runs in a worker pool, results land in the
 * content-addressed cache, and until a new result is ready the previous one
 * (or the source file) keeps being served.
 *
 * Every importable asset goes through up to two stages: `preview` (seconds:
 * optimised, compressed geometry plus small uncompressed textures with
 * precomputed mips) and `full` (simplified levels, Basis-compressed
 * textures). Small assets, and kinds with a single step, only have `full`.
 */
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  SEPARATOR,
} from "@std/path";
import { AssetCache, type CacheManifest } from "./cache.ts";
import {
  type AssetKind,
  DEFAULT_SETTINGS,
  IMPORTER_VERSION,
  type ImportSettings,
  type ImportStage,
  type ImportStatus,
} from "./format.ts";
import { gltfMaterialNames, importGltf, Unsupported } from "./gltf.ts";
import { sha256 } from "./hash.ts";
import { WorkerPool } from "./pool.ts";
import type { TextureResult, TextureRole } from "./texture.ts";

const KINDS: Record<string, AssetKind> = {
  ".glb": "mesh",
  ".gltf": "mesh",
  ".png": "texture",
  ".jpg": "texture",
  ".jpeg": "texture",
  ".wav": "sound",
  ".ogg": "sound",
  ".mp3": "sound",
};

/** The kind of asset a path is imported as, or null when it is not imported. */
export function importKind(path: string): AssetKind | null {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? null : KINDS[path.slice(dot).toLowerCase()] ?? null;
}

/** Sampling role of a standalone texture, from its file name. */
export function textureRole(path: string): TextureRole {
  const name = basename(path).toLowerCase();
  if (/(^|[_\-.])(n|nrm|nor|normal|normals)([_\-.]|$)/.test(name)) {
    return "normal";
  }
  if (
    /(^|[_\-.])(orm|arm|mr|rough|roughness|metal|metallic|ao|occlusion|height|mask|disp)([_\-.]|$)/
      .test(name)
  ) return "data";
  return "color";
}

export interface ImportOutput {
  key: string;
  stage: ImportStage;
  /** Absolute path of the file to serve in place of the source. */
  file: string;
  type: string;
  bytes: number;
  /** Extension of the output, for builds that store it beside the source. */
  ext: string;
}

interface Entry {
  path: string;
  kind: AssetKind;
  status: ImportStatus;
  /** Bumped by every change; a running import with an old value is dropped. */
  version: number;
  outputs: Partial<Record<ImportStage, ImportOutput>>;
  /** Assets-relative files a glTF reads (buffers, images). */
  deps: string[];
  waiters: { stage: ImportStage; resolve: () => void }[];
  running?: Promise<void>;
  /** The texture thumbnail being generated for the current content. */
  thumb?: Promise<void>;
}

export interface ImporterOptions {
  assetsDir: string;
  cacheDir: string;
  settings?: {
    minBytes?: number;
    textures?: Partial<ImportSettings["textures"]>;
    meshes?: Partial<ImportSettings["meshes"]>;
  };
  workers?: number;
  /** Produce the quick preview stage first (default). Builds skip it. */
  previews?: boolean;
  onStatus?: (status: ImportStatus) => void;
  log?: (line: string) => void;
}

const MIME: Record<string, string> = {
  glb: "model/gltf-binary",
  ktx2: "image/ktx2",
  ogg: "audio/ogg",
  wav: "audio/wav",
  mp3: "audio/mpeg",
};

/** Sources at least this large get a quick preview stage first. */
const PREVIEW_ABOVE = 1024 * 1024;
/** Bumped when thumbnail content or its renderer changes. */
export const THUMBNAIL_VERSION = 1;

export class AssetImporter {
  readonly cache: AssetCache;
  readonly settings: ImportSettings;
  #assets: string;
  #entries = new Map<string, Entry>();
  #pool?: WorkerPool;
  #workers?: number;
  #opts: ImporterOptions;
  #disposed = false;
  #active = new Set<Promise<void>>();

  constructor(options: ImporterOptions) {
    this.#opts = options;
    this.#assets = resolve(options.assetsDir);
    this.cache = new AssetCache(options.cacheDir);
    this.#workers = options.workers;
    const s = options.settings ?? {};
    this.settings = {
      minBytes: s.minBytes ?? DEFAULT_SETTINGS.minBytes,
      textures: { ...DEFAULT_SETTINGS.textures, ...s.textures },
      meshes: { ...DEFAULT_SETTINGS.meshes, ...s.meshes },
    };
  }

  get pool(): WorkerPool {
    return this.#pool ??= new WorkerPool(this.#workers);
  }

  // ---- queries ---------------------------------------------------------------

  statuses(): ImportStatus[] {
    return [...this.#entries.values()].map((e) => ({ ...e.status }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  status(path: string): ImportStatus | undefined {
    const e = this.#entries.get(path);
    return e && { ...e.status };
  }

  /** The best finished output for a path, if any. */
  output(path: string): ImportOutput | undefined {
    const e = this.#entries.get(path);
    return e?.outputs.full ?? e?.outputs.preview;
  }

  /** Files that were folded into an import and need not ship (glTF buffers
   * and images beside a `.gltf`). */
  consumed(): Set<string> {
    const out = new Set<string>();
    for (const e of this.#entries.values()) {
      if (e.outputs.full || e.outputs.preview) {
        for (const d of e.deps) out.add(d);
      }
    }
    return out;
  }

  /** Resolve once `path` has produced `stage` (or failed/skipped), or after
   * `timeoutMs`. */
  wait(path: string, stage: ImportStage, timeoutMs = Infinity): Promise<void> {
    const e = this.#entries.get(path);
    if (!e || this.#finished(e, stage)) return Promise.resolve();
    return new Promise((done) => {
      const waiter = { stage, resolve: done };
      e.waiters.push(waiter);
      if (Number.isFinite(timeoutMs)) {
        setTimeout(() => {
          e.waiters = e.waiters.filter((w) => w !== waiter);
          done();
        }, timeoutMs);
      }
    });
  }

  /** Resolves when no import is queued or running. */
  async idle(): Promise<void> {
    while (this.#active.size) await Promise.all([...this.#active]);
  }

  // ---- changes ---------------------------------------------------------------

  /** Queue every importable file under the assets directory. */
  async scan(): Promise<void> {
    const paths: string[] = [];
    const walk = async (dir: string) => {
      let entries: Deno.DirEntry[];
      try {
        entries = await Array.fromAsync(Deno.readDir(dir));
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory) await walk(full);
        else if (entry.isFile) {
          paths.push(relative(this.#assets, full).split(SEPARATOR).join("/"));
        }
      }
    };
    await walk(this.#assets);
    for (const path of paths) this.update(path);
  }

  /** A file was added or changed (any file: models depend on their buffers). */
  update(path: string): void {
    if (this.#disposed) return;
    if (importKind(path)) this.#queue(path);
    for (const e of this.#entries.values()) {
      if (e.deps.includes(path)) this.#queue(e.path);
    }
  }

  remove(path: string): void {
    const e = this.#entries.get(path);
    if (e) {
      e.version++;
      this.#entries.delete(path);
      this.#wake(e);
    }
    for (const other of this.#entries.values()) {
      if (other.deps.includes(path)) this.#queue(other.path);
    }
  }

  /** Drop cache entries that no current output uses and nothing has read in
   * two weeks. */
  async collectGarbage(): Promise<number> {
    const live = new Set<string>();
    for (const e of this.#entries.values()) {
      for (const o of Object.values(e.outputs)) live.add(o.key);
    }
    return await this.cache.prune(live, 14 * 24 * 3600 * 1000);
  }

  dispose(): void {
    this.#disposed = true;
    this.#pool?.terminate();
    for (const e of this.#entries.values()) this.#wake(e, true);
  }

  // ---- thumbnails ------------------------------------------------------------

  async #thumbKey(source: string, variant: string): Promise<string> {
    return await sha256(source, "thumb", variant, String(THUMBNAIL_VERSION));
  }

  /** Absolute path of a cached thumbnail for the asset's current content. */
  async thumbnail(path: string, variant = "asset"): Promise<string | null> {
    const entry = this.#entries.get(path);
    const source = entry?.status.source;
    if (!source) return null;
    if (variant === "asset" && entry.thumb) {
      await Promise.race([
        entry.thumb,
        new Promise((r) => setTimeout(r, 4000)),
      ]);
    }
    const key = await this.#thumbKey(source, variant);
    if (!await this.cache.manifest(key)) return null;
    await Deno.utime(this.cache.path(key), new Date(), new Date()).catch(
      () => {},
    );
    return this.cache.path(key, "thumb.png");
  }

  /** Store a thumbnail rendered by the editor; ignored when the asset has
   * changed since `source` was read. */
  async storeThumbnail(
    path: string,
    variant: string,
    source: string,
    png: Uint8Array,
  ): Promise<boolean> {
    const e = this.#entries.get(path);
    if (!e || e.status.source !== source) return false;
    const key = await this.#thumbKey(source, variant);
    await this.cache.store({
      key,
      source: path,
      stage: "thumb",
      main: "thumb.png",
      type: "image/png",
      ms: 0,
      meta: { variant },
    }, { "thumb.png": png });
    return true;
  }

  // ---- internals -------------------------------------------------------------

  #finished(e: Entry, stage: ImportStage): boolean {
    const s = e.status;
    if (s.state === "failed" || s.state === "skipped") return true;
    return stage === "preview" ? s.done.length > 0 : s.done.includes("full");
  }

  #wake(e: Entry, all = false) {
    e.waiters = e.waiters.filter((w) => {
      if (all || this.#finished(e, w.stage)) {
        w.resolve();
        return false;
      }
      return true;
    });
  }

  #emit(e: Entry) {
    this.#wake(e);
    this.#opts.onStatus?.({ ...e.status });
  }

  #queue(path: string) {
    const kind = importKind(path)!;
    let e = this.#entries.get(path);
    if (!e) {
      e = {
        path,
        kind,
        version: 0,
        outputs: {},
        deps: [],
        waiters: [],
        status: {
          path,
          kind,
          state: "queued",
          stage: "preview",
          done: [],
          progress: 0,
          sourceBytes: 0,
          ms: {},
        },
      };
      this.#entries.set(path, e);
    }
    const version = ++e.version;
    // The previous outputs stay available until the new ones replace them.
    e.status = {
      ...e.status,
      state: "queued",
      progress: 0,
      message: undefined,
      done: [],
    };
    this.#emit(e);
    const previous = e.running ?? Promise.resolve();
    const run = previous.then(() => this.#run(e!, version)).catch((error) => {
      if (!this.#disposed) this.#opts.log?.(`import ${path}: ${error}`);
    }).finally(() => {
      this.#active.delete(run);
      if (e!.running === run) e!.running = undefined;
    });
    e.running = run;
    this.#active.add(run);
  }

  async #stable(file: string): Promise<Deno.FileInfo | null> {
    let last = -1, lastTime = -1;
    // Small files are written in one go; a torn read would be followed by
    // another change event anyway. Large ones may still be copying.
    try {
      const first = await Deno.stat(file);
      if (first.size < 256 * 1024) return first;
    } catch {
      return null;
    }
    for (let i = 0; i < 100; i++) {
      let info: Deno.FileInfo;
      try {
        info = await Deno.stat(file);
      } catch {
        return null;
      }
      const time = info.mtime?.getTime() ?? 0;
      if (info.size === last && time === lastTime) return info;
      last = info.size;
      lastTime = time;
      await new Promise((r) => setTimeout(r, 60));
    }
    return await Deno.stat(file);
  }

  async #run(e: Entry, version: number) {
    const current = () => !this.#disposed && e.version === version;
    const file = join(this.#assets, e.path);
    const info = await this.#stable(file);
    if (!current()) return;
    if (!info) {
      this.#entries.delete(e.path);
      return;
    }
    const started = performance.now();
    let bytes: Uint8Array;
    try {
      bytes = await Deno.readFile(file);
    } catch {
      this.#entries.delete(e.path);
      return;
    }
    if (!current()) return;
    const deps = e.path.toLowerCase().endsWith(".gltf")
      ? await this.#gltfDeps(e.path, bytes)
      : [];
    e.deps = deps.map((d) => d.path);
    const source = await sha256(bytes, ...deps.map((d) => d.hash));
    if (!current()) return;
    e.status = {
      ...e.status,
      source,
      sourceBytes: bytes.length + deps.reduce((n, d) => n + d.size, 0),
    };
    if (e.kind === "texture") {
      e.thumb = this.#thumbnail(e, bytes, source, current);
    } else if (e.kind === "mesh") {
      e.status.materials = gltfMaterialNames(bytes);
    }
    const total = e.status.sourceBytes;
    if (total < this.settings.minBytes) {
      e.outputs = {};
      e.status = {
        ...e.status,
        state: "skipped",
        stage: "full",
        done: [],
        progress: 1,
        outputBytes: undefined,
        message: "small enough to use as is",
      };
      this.#emit(e);
      return;
    }
    const stages: ImportStage[] =
      e.kind !== "sound" && total >= PREVIEW_ABOVE &&
        this.#opts.previews !== false
        ? ["preview", "full"]
        : ["full"];
    for (const stage of stages) {
      if (!current()) return;
      e.status = { ...e.status, state: "importing", stage, progress: 0 };
      this.#emit(e);
      const t0 = stage === "preview" ? started : performance.now();
      try {
        const out = await this.#stage(e, stage, bytes, source, deps, current);
        if (!current()) return;
        e.outputs[stage] = out.output;
        if (stage === "full") delete e.outputs.preview;
        const ms = Math.round(performance.now() - started);
        e.status = {
          ...e.status,
          state: stage === "full" ? "ready" : "importing",
          stage,
          done: [...e.status.done, stage],
          progress: stage === "full" ? 1 : 0,
          outputBytes: out.output.bytes,
          ms: { ...e.status.ms, [stage]: ms },
          materials: out.materials ?? e.status.materials,
          message: undefined,
        };
        void t0;
        this.#opts.log?.(
          `${e.path}: ${stage} ${(ms / 1000).toFixed(1)}s ${
            mb(bytes.length)
          } -> ${mb(out.output.bytes)}${out.cached ? " (cached)" : ""}`,
        );
        this.#emit(e);
      } catch (error) {
        if (!current()) return;
        const message = error instanceof Error ? error.message : String(error);
        const skipped = error instanceof Unsupported;
        e.outputs = {};
        e.status = {
          ...e.status,
          state: skipped ? "skipped" : "failed",
          stage,
          progress: 1,
          message,
        };
        this.#opts.log?.(
          `${e.path}: ${
            skipped ? "served as is" : "import failed"
          } (${message})`,
        );
        this.#emit(e);
        return;
      }
    }
  }

  async #stage(
    e: Entry,
    stage: ImportStage,
    bytes: Uint8Array,
    source: string,
    deps: { path: string; hash: string; size: number }[],
    current: () => boolean,
  ): Promise<{ output: ImportOutput; cached: boolean; materials?: string[] }> {
    void deps;
    const key = await sha256(
      source,
      e.kind,
      stage,
      String(IMPORTER_VERSION),
      JSON.stringify([this.settings.textures, this.settings.meshes]),
    );
    const ext = e.kind === "mesh" ? "glb" : e.kind === "texture" ? "ktx2" : "";
    const hit = await this.cache.manifest(key);
    if (hit) {
      const dir = this.cache.path(key);
      await Deno.utime(dir, new Date(), new Date()).catch(() => {});
      return {
        output: {
          key,
          stage,
          file: this.cache.path(key, hit.main),
          type: hit.type,
          bytes: hit.files[hit.main],
          ext: hit.main.split(".").pop()!,
        },
        cached: true,
        materials: hit.meta.materials as string[] | undefined,
      };
    }
    const runner = {
      run: <T>(
        op: string,
        payload: unknown,
        options: Parameters<WorkerPool["run"]>[2] = {},
      ) =>
        this.pool.run<T>(op, payload, {
          ...options,
          skip: () => !current(),
        }),
    };
    const started = performance.now();
    let main: string, data: Uint8Array;
    const meta: Record<string, unknown> = {};
    let materials: string[] | undefined;
    if (e.kind === "mesh") {
      const base = dirname(join(this.#assets, e.path));
      const out = await importGltf(
        bytes,
        (uri) => this.#readDependency(base, uri),
        stage,
        this.settings,
        runner,
        (done, total) => {
          e.status = { ...e.status, progress: total ? done / total : 1 };
          this.#opts.onStatus?.({ ...e.status });
        },
      );
      main = "model.glb";
      data = out.glb;
      materials = out.materials;
      Object.assign(meta, out.stats, { materials });
    } else if (e.kind === "texture") {
      const result = await runner.run<TextureResult>(
        stage === "preview" ? "texture.preview" : "texture.full",
        { bytes, role: textureRole(e.path), settings: this.settings.textures },
        { priority: stage === "preview" ? 0 : 10 },
      );
      main = "texture.ktx2";
      data = result.ktx2;
      Object.assign(meta, {
        width: result.width,
        height: result.height,
        sourceWidth: result.sourceWidth,
        sourceHeight: result.sourceHeight,
        codec: result.codec,
      });
    } else {
      const result = await runner.run<
        { bytes: Uint8Array; ext: string; mime: string; codec: string }
      >("audio", { bytes, path: e.path }, { priority: 10 });
      main = `sound.${result.ext}`;
      data = result.bytes;
      Object.assign(meta, { codec: result.codec });
    }
    void ext;
    const type = MIME[main.split(".").pop()!] ?? "application/octet-stream";
    const manifest: Omit<CacheManifest, "files"> = {
      key,
      source: e.path,
      stage,
      main,
      type,
      ms: Math.round(performance.now() - started),
      meta,
    };
    if (!current()) throw new Error("superseded");
    await this.cache.store(manifest, { [main]: data });
    return {
      output: {
        key,
        stage,
        file: this.cache.path(key, main),
        type,
        bytes: data.length,
        ext: main.split(".").pop()!,
      },
      cached: false,
      materials,
    };
  }

  async #thumbnail(
    e: Entry,
    bytes: Uint8Array,
    source: string,
    current: () => boolean,
  ) {
    try {
      const key = await this.#thumbKey(source, "asset");
      if (await this.cache.manifest(key)) return;
      const png = await this.pool.run<Uint8Array>(
        "texture.thumbnail",
        { bytes: bytes.slice(), size: 128 },
        { priority: 5, skip: () => !current() },
      );
      await this.cache.store({
        key,
        source: e.path,
        stage: "thumb",
        main: "thumb.png",
        type: "image/png",
        ms: 0,
        meta: { variant: "asset" },
      }, { "thumb.png": png });
    } catch {
      // Thumbnails are best effort (unsupported or superseded).
    }
  }

  async #readDependency(base: string, uri: string): Promise<Uint8Array> {
    const file = resolve(base, uri);
    if (!file.startsWith(this.#assets + SEPARATOR)) {
      throw new Error(`glTF reference leaves the assets directory: ${uri}`);
    }
    return await Deno.readFile(file);
  }

  async #gltfDeps(path: string, bytes: Uint8Array) {
    try {
      const json = JSON.parse(new TextDecoder().decode(bytes));
      const uris: string[] = [
        ...(json.buffers ?? []).map((b: { uri?: string }) => b.uri),
        ...(json.images ?? []).map((i: { uri?: string }) => i.uri),
      ].filter((u): u is string => !!u && !u.startsWith("data:"));
      const base = dirname(join(this.#assets, path));
      const out: { path: string; hash: string; size: number }[] = [];
      for (const uri of uris) {
        try {
          const data = await this.#readDependency(
            base,
            decodeURIComponent(uri),
          );
          out.push({
            path: relative(this.#assets, resolve(base, decodeURIComponent(uri)))
              .split(SEPARATOR).join("/"),
            hash: await sha256(data),
            size: data.length,
          });
        } catch {
          // Missing now; importing will report it.
        }
      }
      return out;
    } catch {
      return [];
    }
  }
}

function mb(bytes: number): string {
  return bytes >= 1e6
    ? `${(bytes / 1e6).toFixed(1)} MB`
    : `${(bytes / 1e3).toFixed(0)} kB`;
}
