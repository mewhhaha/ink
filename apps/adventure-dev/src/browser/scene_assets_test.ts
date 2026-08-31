import {
  type AssetBuild,
  build_asset_manifest,
  serialize_asset_manifest,
} from "@ink/assets/build.ts";
import { asset_id } from "@ink/assets/identity.ts";
import { assertEquals, assertRejects } from "@std/assert";
import {
  adventure_mesh_assets,
  adventure_texture_assets,
  type AdventureRenderAssetSources,
  build_adventure_render_asset_bundle,
} from "../prepared_assets.ts";
import { SceneAssetStore } from "./scene_assets.ts";

const triangle_obj = `v 0 0 0
v 1 0 0
v 0 1 0
vn 0 0 1
f 1//1 2//1 3//1
`;

Deno.test("prepared scene resources preserve Blot numeric mesh and texture mappings", async () => {
  const build = await fixture_build(fixture_sources());
  const reads: string[] = [];
  const store = fixture_store(() => build, reads);

  const loaded = await store.replace([
    { type: "mesh", id: 41, asset: adventure_mesh_assets.gate },
    { type: "texture", id: 7, asset: adventure_texture_assets.oak },
  ]);

  assertEquals(loaded.meshes.length, 1);
  assertEquals(loaded.meshes[0].id, 41);
  assertEquals(loaded.meshes[0].asset, adventure_mesh_assets.gate);
  assertEquals(loaded.meshes[0].indices, new Uint32Array([0, 1, 2]));
  assertEquals(
    loaded.meshes[0].vertices,
    new Float32Array([
      0,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      1,
      0,
      0,
    ]),
  );
  assertEquals(loaded.textures, [{
    id: 7,
    asset: adventure_texture_assets.oak,
    bytes: new Uint8Array([137, 80, 78, 71, 3]),
    mime_type: "image/png",
  }]);
  assertEquals(
    new Set(reads),
    new Set(build.manifest.assets.map(({ location }) => location)),
  );
});

Deno.test("a digest failure does not replace the last prepared scene revision", async () => {
  const original = await fixture_build(fixture_sources());
  const replacement = await fixture_build(
    fixture_sources(new Uint8Array([137, 80, 78, 71, 9])),
  );
  let current = original;
  const artifacts = new Map(
    [...original.artifacts, ...replacement.artifacts].map(
      ({ location, bytes }) => [location, bytes] as const,
    ),
  );
  const store = new SceneAssetStore({
    name: "memory manifest",
    read_manifest: () =>
      Promise.resolve(serialize_asset_manifest(current.manifest)),
    artifacts: {
      read(location) {
        const bytes = artifacts.get(location);
        if (bytes === undefined) {
          throw new Error(
            `fixture artifact ${JSON.stringify(location)} is missing`,
          );
        }
        return Promise.resolve(bytes);
      },
    },
  });
  const resources = [{
    type: "texture" as const,
    id: 3,
    asset: adventure_texture_assets.oak,
  }];
  const retained = await store.replace(resources);
  const changed_texture = replacement.manifest.assets.find((entry) => {
    const previous = original.manifest.assets.find(({ id }) => id === entry.id);
    return entry.kind === "prepared-texture-mip" &&
      previous?.digest !== entry.digest;
  });
  if (changed_texture === undefined) {
    throw new Error("replacement fixture did not change a texture artifact");
  }
  artifacts.set(
    changed_texture.location,
    new Uint8Array([137, 80, 78, 71, 8]),
  );
  current = replacement;

  await assertRejects(
    () => store.replace(resources),
    Error,
    "does not match manifest digest",
  );
  assertEquals(
    retained.textures[0].bytes,
    new Uint8Array([137, 80, 78, 71, 3]),
  );
});

Deno.test("prepared scene resources reject logical identities absent from the catalog", async () => {
  const build = await fixture_build(fixture_sources());
  const store = fixture_store(() => build);

  await assertRejects(
    () =>
      store.replace([{
        type: "texture",
        id: 2,
        asset: asset_id<"texture">("adventure/texture/missing"),
      }]),
    Error,
    'references unmapped logical asset "adventure/texture/missing"',
  );
});

Deno.test("scene asset store publishes prepared non-render assets by identity", async () => {
  const render_bundle = build_adventure_render_asset_bundle(fixture_sources());
  const level = new TextEncoder().encode('{"spawn":[2,3]}');
  const build = await build_asset_manifest([
    ...render_bundle.assets,
    {
      id: "levels/starter.json",
      kind: "json",
      bytes: level,
    },
  ], "level manifest");
  const store = fixture_store(() => build);

  assertEquals(
    new TextDecoder().decode(
      await store.read(asset_id("levels/starter.json")),
    ),
    '{"spawn":[2,3]}',
  );
});

async function fixture_build(
  sources: AdventureRenderAssetSources,
): Promise<AssetBuild> {
  const bundle = build_adventure_render_asset_bundle(sources);
  return await build_asset_manifest(bundle.assets, "memory manifest");
}

function fixture_sources(
  oak_png = new Uint8Array([137, 80, 78, 71, 3]),
): AdventureRenderAssetSources {
  return {
    cube_obj: triangle_obj,
    flagstone_png: new Uint8Array([137, 80, 78, 71, 1]),
    gate_obj: triangle_obj,
    limestone_png: new Uint8Array([137, 80, 78, 71, 2]),
    oak_png,
    stairs_obj: triangle_obj,
  };
}

function fixture_store(
  read_build: () => AssetBuild,
  reads: string[] = [],
): SceneAssetStore {
  return new SceneAssetStore({
    name: "memory manifest",
    read_manifest: () =>
      Promise.resolve(serialize_asset_manifest(read_build().manifest)),
    artifacts: {
      read(location) {
        reads.push(location);
        const artifact = read_build().artifacts.find((candidate) =>
          candidate.location === location
        );
        if (artifact === undefined) {
          throw new Error(
            `fixture artifact ${JSON.stringify(location)} is missing`,
          );
        }
        return Promise.resolve(artifact.bytes);
      },
    },
  });
}
