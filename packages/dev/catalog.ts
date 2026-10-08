import { builtinMeshes, builtinTextures, type Catalog } from "@ink/schema";
import { join, relative, SEPARATOR as sep } from "@std/path";

export type AssetKind = "mesh" | "texture" | "sound";

const KINDS: Record<string, AssetKind> = {
  ".glb": "mesh",
  ".gltf": "mesh",
  ".obj": "mesh",
  ".png": "texture",
  ".jpg": "texture",
  ".jpeg": "texture",
  ".webp": "texture",
  ".wav": "sound",
  ".ogg": "sound",
  ".mp3": "sound",
};

export function assetKind(path: string): AssetKind | null {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return null;
  return KINDS[path.slice(dot).toLowerCase()] ?? null;
}

/** Build a catalog from asset paths (relative, `/` separated). */
export function catalogFromPaths(paths: Iterable<string>): Catalog {
  const found: Record<AssetKind, string[]> = {
    mesh: [],
    texture: [],
    sound: [],
  };
  for (const path of paths) {
    const kind = assetKind(path);
    if (kind) found[kind].push(path);
  }
  const sort = (list: string[]) =>
    [...new Set(list)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    assets: {
      mesh: [...builtinMeshes, ...sort(found.mesh)],
      texture: [...builtinTextures, ...sort(found.texture)],
      sound: sort(found.sound),
    },
  };
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(dir));
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory) yield* walk(full);
    else if (entry.isFile) yield full;
  }
}

/** Scan an assets directory into a catalog. A missing directory is empty. */
export async function scanAssets(dir: string): Promise<Catalog> {
  const paths: string[] = [];
  for await (const file of walk(dir)) {
    paths.push(relative(dir, file).split(sep).join("/"));
  }
  return catalogFromPaths(paths);
}
