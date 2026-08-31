import {
  build_asset_manifest,
  serialize_asset_manifest,
} from "@ink/assets/build.ts";
import { parse_asset_manifest } from "@ink/assets/manifest.ts";
import { assertEquals } from "@std/assert";
import {
  adventure_render_bundle_asset,
  build_adventure_render_asset_bundle,
  parse_adventure_render_asset_catalog,
} from "./prepared_assets.ts";

const triangle_obj = `v 0 0 0
v 1 0 0
v 0 1 0
f 1 2 3
`;

Deno.test("adventure asset preparation publishes only digest-addressable runtime formats", async () => {
  const sources = {
    cube_obj: triangle_obj,
    flagstone_png: new Uint8Array([137, 80, 78, 71, 1]),
    gate_obj: triangle_obj,
    limestone_png: new Uint8Array([137, 80, 78, 71, 2]),
    oak_png: new Uint8Array([137, 80, 78, 71, 3]),
    stairs_obj: triangle_obj,
  };
  const first = build_adventure_render_asset_bundle(sources);
  const second = build_adventure_render_asset_bundle(sources);
  const [first_build, second_build] = await Promise.all([
    build_asset_manifest(first.assets, "adventure manifest"),
    build_asset_manifest(second.assets, "adventure manifest"),
  ]);
  const catalog_asset = first.assets.find(({ id }) =>
    id === adventure_render_bundle_asset
  );
  if (catalog_asset === undefined) {
    throw new Error("adventure preparation omitted its bundle catalog");
  }
  const catalog = parse_adventure_render_asset_catalog(
    catalog_asset.bytes,
    "prepared catalog",
  );

  assertEquals(catalog_asset.dependencies, [catalog.scene]);
  assertEquals(
    first.assets.every(({ id, kind }) =>
      !/\.(?:obj|png)$/i.test(id) && kind !== "obj" && kind !== "png"
    ),
    true,
  );
  assertEquals(
    first_build.manifest.assets.every(({ digest, location }) =>
      location === `assets/.ink/${digest.slice("sha256:".length)}`
    ),
    true,
  );
  assertEquals(
    serialize_asset_manifest(first_build.manifest),
    serialize_asset_manifest(second_build.manifest),
  );
});

Deno.test("the adventure game build publishes no OBJ or source texture paths", async () => {
  const generated = new URL("../generated/", import.meta.url);
  const files = await collect_relative_files(generated);
  assertEquals(
    files.filter((path) => /\.(?:obj|png)$/i.test(path)),
    [],
  );
  const manifest_source = await Deno.readTextFile(
    new URL("assets.manifest.json", generated),
  );
  const parsed = parse_asset_manifest(
    JSON.parse(manifest_source),
    "adventure generated manifest",
  );
  if (parsed.type !== "ready") throw new Error(parsed.reason);
  assertEquals(
    parsed.manifest.assets.filter(({ kind }) =>
      kind === "obj" || kind === "png"
    ),
    [],
  );
});

async function collect_relative_files(
  directory: URL,
  prefix = "",
): Promise<readonly string[]> {
  const entries = [];
  for await (const entry of Deno.readDir(directory)) entries.push(entry);
  entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  );
  const files: string[] = [];
  for (const entry of entries) {
    const relative_path = `${prefix}${entry.name}`;
    if (entry.isDirectory) {
      files.push(
        ...await collect_relative_files(
          new URL(`${entry.name}/`, directory),
          `${relative_path}/`,
        ),
      );
      continue;
    }
    if (entry.isFile) files.push(relative_path);
  }
  return files;
}
