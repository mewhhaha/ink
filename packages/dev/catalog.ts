import {
  type AtlasInfo,
  atlasInfo,
  builtinMeshes,
  builtinTextures,
  type Catalog,
  parseAtlas,
} from "@ink/schema";
import { join, relative, SEPARATOR as sep } from "@std/path";

export type AssetKind =
  | "mesh"
  | "texture"
  | "sound"
  | "atlas"
  | "terrain"
  | "scatter";

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
  ".terrain": "terrain",
  ".scatter": "scatter",
};

export function assetKind(path: string): AssetKind | null {
  if (path.toLowerCase().endsWith(".atlas.json")) return "atlas";
  const dot = path.lastIndexOf(".");
  if (dot < 0) return null;
  return KINDS[path.slice(dot).toLowerCase()] ?? null;
}

/** Build a catalog from asset paths (relative, `/` separated). */
export function catalogFromPaths(
  paths: Iterable<string>,
  atlases: Record<string, AtlasInfo> = {},
): Catalog {
  const found: Record<AssetKind, string[]> = {
    mesh: [],
    texture: [],
    sound: [],
    atlas: [],
    terrain: [],
    scatter: [],
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
      ...(found.atlas.length ? { atlas: sort(found.atlas) } : {}),
      ...(found.terrain.length ? { terrain: sort(found.terrain) } : {}),
      ...(found.scatter.length ? { scatter: sort(found.scatter) } : {}),
    },
    ...(Object.keys(atlases).length ? { atlases } : {}),
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
export async function scanAssets(
  dir: string,
  /** The last good catalog: an atlas that is mid-edit and does not parse
   * keeps its previous description, so the running game is not pulled apart. */
  previous?: Catalog,
): Promise<Catalog> {
  const paths: string[] = [];
  for await (const file of walk(dir)) {
    paths.push(relative(dir, file).split(sep).join("/"));
  }
  // Atlas files describe their frames to Blot, so the catalog reads them.
  const atlases: Record<string, AtlasInfo> = {};
  for (const path of paths) {
    if (assetKind(path) !== "atlas") continue;
    try {
      atlases[path] = atlasInfo(
        parseAtlas(await Deno.readTextFile(join(dir, path)), path),
      );
    } catch (error) {
      console.warn(`ink: ${error instanceof Error ? error.message : error}`);
      const kept = previous?.atlases?.[path];
      if (kept) atlases[path] = kept;
    }
  }
  return catalogFromPaths(paths, atlases);
}
