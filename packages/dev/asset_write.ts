/**
 * In-place writes of large binary assets (`*.terrain`, `*.scatter`), for the
 * editing tools: a brush stroke changes a few kilobytes of a file of tens of
 * megabytes, so the tools send only the changed byte ranges.
 *
 *   PUT   /__ink/assets-write/<path>                 body = the whole file;
 *                                                    replaces it atomically
 *   PUT   /__ink/assets-write/<path>?create=1        body = the whole file; 409 if it exists
 *   PUT   /__ink/assets-write/<path>?create=1&size=N empty body; a zero-filled file of N bytes
 *   PATCH /__ink/assets-write/<path>                 body = segments (see
 *                                                    `segments.ts`) written in
 *                                                    place, in order
 *
 * Only `.terrain` and `.scatter` files inside the assets directory, no
 * `..`, no hidden segments; bodies up to 128 MiB, files up to 512 MiB. A
 * PATCH cannot grow a file or write outside it. Writes to one file are
 * serialised.
 *
 * The dev server's file watcher reports every change under `assets/`, one
 * event per write call and for seconds afterwards (a stroke is a hundred
 * writes). The editor that made a write already shows it, and a reload would
 * throw away the data being edited, so the host asks `isOwnChange(file)` and
 * skips the `ink:asset` event for events that say nothing new: while a write
 * is in progress, and whenever the file is exactly as the last write left it
 * (same size and modification time, however late the event arrives). Any
 * other change to the file is reported, and so is a file this object never
 * wrote.
 */
import {
  dirname,
  extname,
  join,
  relative,
  resolve,
  SEPARATOR as sep,
} from "@std/path";
import { resolveInside } from "./paths.ts";
import { decodeSegments } from "./segments.ts";

export const ASSET_WRITE_EXTENSIONS: readonly string[] = [
  ".terrain",
  ".scatter",
];
export const MAX_ASSET_BODY = 128 * 1024 * 1024;
export const MAX_ASSET_FILE = 512 * 1024 * 1024;

export class AssetWriteError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface Own {
  /** Writes in flight. */
  busy: number;
  /** The file's size and modification time after the last own write. */
  size: number;
  mtime: number;
}

export class AssetWrites {
  #own = new Map<string, Own>();
  #queue = new Map<string, Promise<unknown>>();

  constructor(readonly assetsDir: string) {}

  /** The file a request path names, or an error naming what is wrong. */
  resolve(tail: string): { file: string; path: string } {
    let file: string;
    try {
      file = resolveInside(this.assetsDir, tail);
    } catch (error) {
      throw new AssetWriteError(
        400,
        error instanceof Error ? error.message : String(error),
      );
    }
    const path = relative(this.assetsDir, file).split(sep).join("/");
    if (path.split("/").some((s) => s.startsWith("."))) {
      throw new AssetWriteError(400, `hidden path: ${path}`);
    }
    if (!ASSET_WRITE_EXTENSIONS.includes(extname(file).toLowerCase())) {
      throw new AssetWriteError(
        400,
        `only ${ASSET_WRITE_EXTENSIONS.join(" and ")} files can be written`,
      );
    }
    return { file, path };
  }

  /** The file, or the nearest folder of it that exists, must really lie in
   * the assets directory: a symbolic link out of it is not a way to write
   * elsewhere. */
  async #contained(file: string): Promise<void> {
    const root = await Deno.realPath(this.assetsDir).catch(() =>
      resolve(this.assetsDir)
    );
    let at = file;
    for (;;) {
      try {
        const real = await Deno.realPath(at);
        if (real === root || real.startsWith(root + sep)) return;
        throw new AssetWriteError(400, "path leaves the assets directory");
      } catch (error) {
        if (error instanceof AssetWriteError) throw error;
        const parent = dirname(at);
        if (parent === at) throw error;
        at = parent;
      }
    }
  }

  /** Perform one request. Throws `AssetWriteError` with an HTTP status. */
  async handle(
    method: string,
    tail: string,
    query: URLSearchParams,
    body: Uint8Array,
  ): Promise<{ size: number }> {
    const { file } = this.resolve(tail);
    if (body.length > MAX_ASSET_BODY) {
      throw new AssetWriteError(413, "body too large");
    }
    // Queue before any await, so writes keep the order requests arrived in.
    return await this.#serial(file, async () => {
      await this.#contained(file);
      this.#begin(file);
      try {
        if (method === "PATCH") return await this.#patch(file, body);
        if (method !== "PUT") {
          throw new AssetWriteError(405, `${method} not allowed`);
        }
        const create = query.get("create") === "1";
        const size = query.get("size");
        if (size !== null) {
          const n = Number(size);
          if (!create) {
            throw new AssetWriteError(400, "size needs create=1");
          }
          if (!/^\d+$/.test(size) || n > MAX_ASSET_FILE) {
            throw new AssetWriteError(400, `bad size: ${size}`);
          }
          if (body.length) {
            throw new AssetWriteError(400, "a sized file has no body");
          }
          return await this.#create(file, n);
        }
        if (body.length > MAX_ASSET_FILE) {
          throw new AssetWriteError(413, "file too large");
        }
        return await this.#put(file, body, create);
      } finally {
        await this.#end(file);
      }
    });
  }

  async #serial<T>(file: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#queue.get(file) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.#queue.set(file, next);
    try {
      return await next;
    } finally {
      if (this.#queue.get(file) === next) this.#queue.delete(file);
    }
  }

  async #create(file: string, size: number) {
    await Deno.mkdir(dirname(file), { recursive: true });
    let handle: Deno.FsFile;
    try {
      handle = await Deno.open(file, {
        write: true,
        createNew: true,
      });
    } catch (error) {
      if (error instanceof Deno.errors.AlreadyExists) {
        throw new AssetWriteError(409, "the file already exists");
      }
      throw error;
    }
    try {
      await handle.truncate(size);
    } finally {
      handle.close();
    }
    return { size };
  }

  async #put(file: string, bytes: Uint8Array, create: boolean) {
    const exists = await Deno.stat(file).then(() => true, () => false);
    if (create && exists) {
      throw new AssetWriteError(409, "the file already exists");
    }
    if (!create && !exists) throw new AssetWriteError(404, "no such file");
    await Deno.mkdir(dirname(file), { recursive: true });
    // Hidden, so the watcher and the asset scan ignore the temporary file.
    const temporary = join(
      dirname(file),
      `.${crypto.randomUUID()}.write.tmp`,
    );
    try {
      await Deno.writeFile(temporary, bytes);
      await Deno.rename(temporary, file);
    } finally {
      await Deno.remove(temporary).catch(() => {});
    }
    return { size: bytes.length };
  }

  async #patch(file: string, body: Uint8Array) {
    let segments;
    try {
      segments = decodeSegments(body);
    } catch (error) {
      throw new AssetWriteError(
        400,
        error instanceof Error ? error.message : String(error),
      );
    }
    let handle: Deno.FsFile;
    try {
      handle = await Deno.open(file, { write: true });
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new AssetWriteError(404, "no such file");
      }
      throw error;
    }
    try {
      const { size } = await handle.stat();
      // Check everything first: a bad request changes nothing.
      for (const s of segments) {
        if (s.offset + s.bytes.length > size) {
          throw new AssetWriteError(
            400,
            `segment at ${s.offset} (${s.bytes.length} bytes) is outside the ${size} byte file`,
          );
        }
      }
      for (const s of segments) {
        await handle.seek(s.offset, Deno.SeekMode.Start);
        let done = 0;
        while (done < s.bytes.length) {
          done += await handle.write(s.bytes.subarray(done));
        }
      }
      return { size };
    } finally {
      handle.close();
    }
  }

  // The server's own writes, for the file watcher ------------------------------

  #begin(file: string) {
    const own = this.#own.get(file);
    if (own) {
      own.busy++;
      return;
    }
    this.#own.set(file, { busy: 1, size: -1, mtime: -1 });
  }

  async #end(file: string) {
    const own = this.#own.get(file)!;
    try {
      const info = await Deno.stat(file);
      own.size = info.size;
      own.mtime = info.mtime?.getTime() ?? -1;
    } catch {
      own.size = -1;
    }
    own.busy--;
  }

  /** Whether a change the watcher reports at `file` says nothing new: a write
   * of this object's is in progress, or the file is just as the last one left
   * it. The watcher reports a write many times and late, so the check is of
   * the file, not of the clock. */
  async isOwnChange(file: string): Promise<boolean> {
    const own = this.#own.get(file);
    if (!own) return false;
    if (own.busy > 0) return true;
    try {
      const info = await Deno.stat(file);
      if (own.busy > 0) return true;
      return info.size === own.size &&
        (info.mtime?.getTime() ?? -1) === own.mtime;
    } catch {
      // Gone: that is a change.
      return false;
    }
  }
}

/** Read a request body, refusing more than `limit` bytes. */
export async function readBody(
  body: AsyncIterable<Uint8Array>,
  limit = MAX_ASSET_BODY,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > limit) throw new AssetWriteError(413, "body too large");
    chunks.push(chunk);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
