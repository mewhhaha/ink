/**
 * The content-addressed import cache: `<dir>/<sha256>/` holds the outputs of
 * one import plus `manifest.json`. The key covers the source bytes (and the
 * bytes of files a model references), the importer version, the stage and the
 * settings, so the same input always lands in the same place and nothing is
 * ever overwritten.
 */
import { join } from "@std/path";

export interface CacheManifest {
  key: string;
  /** Catalog path the output was made from (informational). */
  source: string;
  stage: string;
  /** The file that replaces the source when served. */
  main: string;
  type: string;
  files: Record<string, number>;
  ms: number;
  /** Importer-specific facts (sizes, vertex counts, materials...). */
  meta: Record<string, unknown>;
}

export class AssetCache {
  constructor(readonly dir: string) {}

  path(key: string, name?: string): string {
    return name ? join(this.dir, key, name) : join(this.dir, key);
  }

  async manifest(key: string): Promise<CacheManifest | null> {
    try {
      const manifest = JSON.parse(
        await Deno.readTextFile(join(this.dir, key, "manifest.json")),
      ) as CacheManifest;
      // The main file may have been deleted by hand: treat as a miss.
      await Deno.stat(join(this.dir, key, manifest.main));
      return manifest;
    } catch {
      return null;
    }
  }

  /** Write all files into a temporary directory, then rename it into place. */
  async store(
    manifest: Omit<CacheManifest, "files">,
    files: Record<string, Uint8Array>,
  ): Promise<CacheManifest> {
    await Deno.mkdir(this.dir, { recursive: true });
    const stage = await Deno.makeTempDir({
      dir: this.dir,
      prefix: `.tmp-${manifest.key.slice(0, 8)}-`,
    });
    try {
      const sizes: Record<string, number> = {};
      for (const [name, data] of Object.entries(files)) {
        await Deno.writeFile(join(stage, name), data);
        sizes[name] = data.length;
      }
      const full: CacheManifest = { ...manifest, files: sizes };
      await Deno.writeTextFile(
        join(stage, "manifest.json"),
        JSON.stringify(full, null, 2),
      );
      const target = join(this.dir, manifest.key);
      try {
        await Deno.rename(stage, target);
      } catch {
        // Another process stored the same content first: identical by key.
        await Deno.remove(stage, { recursive: true });
      }
      return full;
    } catch (error) {
      await Deno.remove(stage, { recursive: true }).catch(() => {});
      throw error;
    }
  }

  /** Remove entries that are not `live` and have not been written for
   * `maxAgeMs`. Returns the number removed. */
  async prune(live: Set<string>, maxAgeMs: number): Promise<number> {
    let removed = 0;
    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(Deno.readDir(this.dir));
    } catch {
      return 0;
    }
    for (const entry of entries) {
      if (!entry.isDirectory || live.has(entry.name)) continue;
      const path = join(this.dir, entry.name);
      try {
        const info = await Deno.stat(path);
        const age = Date.now() - (info.mtime?.getTime() ?? 0);
        if (entry.name.startsWith(".tmp-") ? age > 3_600_000 : age > maxAgeMs) {
          await Deno.remove(path, { recursive: true });
          removed++;
        }
      } catch {
        // already gone
      }
    }
    return removed;
  }
}
