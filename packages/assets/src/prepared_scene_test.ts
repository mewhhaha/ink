import { assertEquals, assertThrows } from "@std/assert";
import { build_asset_manifest, serialize_asset_manifest } from "./build.ts";
import type { AssetId } from "./identity.ts";
import {
  build_prepared_static_gltf_scene,
  decode_prepared_static_gltf_scene,
} from "./prepared_scene.ts";
import type { StaticGltfMaterial, StaticGltfScene } from "./prepared_scene.ts";

Deno.test("prepared scenes round trip mesh, material, and texture mip chunks", () => {
  const source = fixture_scene();
  const prepared = build_prepared_static_gltf_scene("fixture/room", source, {
    mesh_chunk_maximum_bytes: 160,
  });
  const artifacts = new Map(
    prepared.assets.map(({ id, bytes }) => [id, bytes] as const),
  );
  const decoded = decode_prepared_static_gltf_scene(
    required_artifact(artifacts, prepared.root),
    "fixture prepared scene",
    (id) => required_artifact(artifacts, id),
  );

  assertEquals(decoded, source);
  assertEquals(
    prepared.assets.filter(({ kind }) => kind === "prepared-mesh-chunk")
      .length,
    2,
  );
  assertEquals(
    prepared.assets.filter(({ kind }) => kind === "prepared-material-chunk")
      .length,
    2,
  );
  assertEquals(
    prepared.assets.filter(({ kind }) => kind === "prepared-texture-mip")
      .length,
    1,
  );
});

Deno.test("prepared scene manifests are deterministic and digest every chunk", async () => {
  const source = fixture_scene();
  const first_prepared = build_prepared_static_gltf_scene(
    "fixture/room",
    source,
  );
  const second_prepared = build_prepared_static_gltf_scene(
    "fixture/room",
    source,
  );
  const [first, second] = await Promise.all([
    build_asset_manifest(first_prepared.assets, "fixture-assets.json"),
    build_asset_manifest(second_prepared.assets, "fixture-assets.json"),
  ]);

  assertEquals(
    serialize_asset_manifest(first.manifest),
    serialize_asset_manifest(second.manifest),
  );
  assertEquals(
    first.manifest.assets.every(({ digest, location }) =>
      location.endsWith(digest.slice("sha256:".length))
    ),
    true,
  );
});

Deno.test("prepared scene decoding rejects truncated mesh chunks with source evidence", () => {
  const prepared = build_prepared_static_gltf_scene(
    "fixture/room",
    fixture_scene(),
  );
  const artifacts = new Map(
    prepared.assets.map(({ id, bytes }) => [id, bytes] as const),
  );
  const mesh = prepared.assets.find(({ kind }) =>
    kind === "prepared-mesh-chunk"
  );
  if (mesh === undefined) throw new Error("fixture has no prepared mesh chunk");
  artifacts.set(mesh.id, mesh.bytes.subarray(0, mesh.bytes.length - 1));

  assertThrows(
    () =>
      decode_prepared_static_gltf_scene(
        required_artifact(artifacts, prepared.root),
        "broken-room.asset",
        (id) => required_artifact(artifacts, id),
      ),
    Error,
    'prepared mesh chunk "broken-room.asset mesh chunk 0" mesh 1 geometry needs',
  );
});

Deno.test("prepared scene builds reject meshes larger than the chunk maximum", () => {
  assertThrows(
    () =>
      build_prepared_static_gltf_scene("fixture/room", fixture_scene(), {
        mesh_chunk_maximum_bytes: 100,
      }),
    Error,
    'prepared scene mesh "room#mesh/stone" needs 147 encoded bytes, exceeding chunk maximum 100',
  );
});

function required_artifact(
  artifacts: ReadonlyMap<string, Uint8Array>,
  id: AssetId,
): Uint8Array {
  const bytes = artifacts.get(id);
  if (bytes === undefined) {
    throw new Error(
      `fixture prepared artifact ${JSON.stringify(id)} is missing`,
    );
  }
  return bytes;
}

function fixture_scene(): StaticGltfScene {
  const textured = material({ base_color_texture: "room#texture/0" });
  return {
    meshes: [
      {
        id: "room#mesh/stone",
        indices: new Uint32Array([0, 1, 2]),
        material: textured,
        vertices: vertices(0),
      },
      {
        id: "room#mesh/metal",
        indices: new Uint32Array([0, 2, 1]),
        material: material({ metallic: 1, roughness: 0.2 }),
        vertices: vertices(1),
      },
    ],
    source: "room.glb",
    textures: [{
      bytes: new Uint8Array([137, 80, 78, 71]),
      id: "room#texture/0",
      mime_type: "image/png",
    }],
    texture_reference_count: 1,
  };
}

function vertices(offset: number): Float32Array {
  return new Float32Array([
    offset,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    offset + 1,
    0,
    0,
    0,
    1,
    0,
    1,
    0,
    offset,
    1,
    0,
    0,
    1,
    0,
    0,
    1,
  ]);
}

function material(
  override: Partial<StaticGltfMaterial> = {},
): StaticGltfMaterial {
  return {
    albedo: [0.5, 0.4, 0.3],
    emissive: [0, 0, 0],
    metallic: 0,
    roughness: 0.8,
    ...override,
  };
}
