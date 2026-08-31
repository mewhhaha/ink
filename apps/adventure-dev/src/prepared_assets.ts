import type { AuthoredAsset } from "@ink/assets/build.ts";
import type {
  StaticGltfMaterial,
  StaticGltfMesh,
  StaticGltfScene,
} from "@ink/assets/prepared_scene.ts";
import { asset_id, type AssetId } from "@ink/assets/identity.ts";
import { parse_obj_model } from "@ink/assets/mesh.ts";
import { build_prepared_static_gltf_scene } from "@ink/assets/prepared_scene.ts";

export const adventure_render_bundle_asset = asset_id<
  "adventure-render-catalog"
>("adventure/render/catalog");

export const adventure_mesh_assets = Object.freeze({
  cube: asset_id<"mesh">("adventure/mesh/cube"),
  gate: asset_id<"mesh">("adventure/mesh/oak-gate"),
  stairs: asset_id<"mesh">("adventure/mesh/stone-stairs"),
});

export const adventure_texture_assets = Object.freeze({
  flagstone: asset_id<"texture">("adventure/texture/flagstone-floor"),
  limestone: asset_id<"texture">("adventure/texture/limestone-wall"),
  oak: asset_id<"texture">("adventure/texture/oak-door"),
});

export interface AdventureRenderAssetSources {
  readonly cube_obj: string;
  readonly flagstone_png: Uint8Array;
  readonly gate_obj: string;
  readonly limestone_png: Uint8Array;
  readonly oak_png: Uint8Array;
  readonly stairs_obj: string;
}

export type AdventurePreparedResource =
  | {
    readonly asset: AssetId<"mesh">;
    readonly prepared_id: string;
    readonly type: "mesh";
  }
  | {
    readonly asset: AssetId<"texture">;
    readonly prepared_id: string;
    readonly type: "texture";
  };

export interface AdventureRenderAssetCatalog {
  readonly resources: readonly AdventurePreparedResource[];
  readonly scene: AssetId<"prepared-static-scene">;
  readonly version: 1;
}

export interface AdventureRenderAssetBundle {
  readonly assets: readonly AuthoredAsset[];
  readonly root: typeof adventure_render_bundle_asset;
}

const text_encoder = new TextEncoder();
const text_decoder = new TextDecoder("utf-8", { fatal: true });
const default_material = Object.freeze(
  {
    albedo: [1, 1, 1],
    emissive: [0, 0, 0],
    metallic: 0,
    roughness: 1,
  } satisfies StaticGltfMaterial,
);

const prepared_mesh_ids = Object.freeze({
  cube: "adventure/render/mesh/cube",
  gate: "adventure/render/mesh/oak-gate",
  stairs: "adventure/render/mesh/stone-stairs",
});

const prepared_texture_ids = Object.freeze({
  flagstone: "adventure/render/texture/flagstone-floor",
  limestone: "adventure/render/texture/limestone-wall",
  oak: "adventure/render/texture/oak-door",
});

export function build_adventure_render_asset_bundle(
  sources: AdventureRenderAssetSources,
): AdventureRenderAssetBundle {
  const scene: StaticGltfScene = Object.freeze({
    meshes: Object.freeze([
      prepare_obj_mesh(
        prepared_mesh_ids.cube,
        sources.cube_obj,
        "adventure cube source",
      ),
      prepare_obj_mesh(
        prepared_mesh_ids.gate,
        sources.gate_obj,
        "adventure oak gate source",
      ),
      prepare_obj_mesh(
        prepared_mesh_ids.stairs,
        sources.stairs_obj,
        "adventure stone stairs source",
      ),
    ]),
    source: "adventure render assets",
    textures: Object.freeze([
      Object.freeze({
        bytes: sources.flagstone_png.slice(),
        id: prepared_texture_ids.flagstone,
        mime_type: "image/png",
      }),
      Object.freeze({
        bytes: sources.limestone_png.slice(),
        id: prepared_texture_ids.limestone,
        mime_type: "image/png",
      }),
      Object.freeze({
        bytes: sources.oak_png.slice(),
        id: prepared_texture_ids.oak,
        mime_type: "image/png",
      }),
    ]),
    texture_reference_count: 0,
  });
  const prepared = build_prepared_static_gltf_scene(
    "adventure/render",
    scene,
  );
  const catalog: AdventureRenderAssetCatalog = Object.freeze({
    resources: Object.freeze([
      prepared_mesh_resource(
        adventure_mesh_assets.cube,
        prepared_mesh_ids.cube,
      ),
      prepared_mesh_resource(
        adventure_mesh_assets.gate,
        prepared_mesh_ids.gate,
      ),
      prepared_mesh_resource(
        adventure_mesh_assets.stairs,
        prepared_mesh_ids.stairs,
      ),
      prepared_texture_resource(
        adventure_texture_assets.flagstone,
        prepared_texture_ids.flagstone,
      ),
      prepared_texture_resource(
        adventure_texture_assets.limestone,
        prepared_texture_ids.limestone,
      ),
      prepared_texture_resource(
        adventure_texture_assets.oak,
        prepared_texture_ids.oak,
      ),
    ]),
    scene: prepared.root,
    version: 1,
  });
  return Object.freeze({
    assets: Object.freeze([
      ...prepared.assets,
      Object.freeze({
        id: adventure_render_bundle_asset,
        kind: "adventure-render-catalog",
        bytes: text_encoder.encode(`${JSON.stringify(catalog)}\n`),
        dependencies: [prepared.root],
      }),
    ]),
    root: adventure_render_bundle_asset,
  });
}

export function parse_adventure_render_asset_catalog(
  bytes: Uint8Array,
  source: string,
): AdventureRenderAssetCatalog {
  let value: unknown;
  try {
    value = JSON.parse(text_decoder.decode(bytes));
  } catch (cause) {
    throw new Error(
      `adventure render asset catalog ${
        JSON.stringify(source)
      } is invalid JSON`,
      { cause },
    );
  }
  const catalog = expect_record(value, "$", source);
  if (catalog.version !== 1) {
    throw new Error(
      `adventure render asset catalog ${JSON.stringify(source)} version ${
        JSON.stringify(catalog.version)
      } is unsupported; expected 1`,
    );
  }
  if (!Array.isArray(catalog.resources)) {
    throw new Error(
      `adventure render asset catalog ${
        JSON.stringify(source)
      } field "$.resources" must be an array`,
    );
  }
  const resources = catalog.resources.map((value, index) =>
    parse_resource(value, `$.resources[${index}]`, source)
  );
  const identities = new Set<AssetId>();
  for (const resource of resources) {
    if (identities.has(resource.asset)) {
      throw new Error(
        `adventure render asset catalog ${
          JSON.stringify(source)
        } repeats resource ${JSON.stringify(resource.asset)}`,
      );
    }
    identities.add(resource.asset);
  }
  return Object.freeze({
    resources: Object.freeze(resources),
    scene: asset_id<"prepared-static-scene">(
      nonempty_string(catalog.scene, "$.scene", source),
    ),
    version: 1,
  });
}

function prepare_obj_mesh(
  id: string,
  source_text: string,
  source: string,
): StaticGltfMesh {
  const model = parse_obj_model(source_text, source);
  const vertices = new Float32Array(model.vertex_count * 8);
  for (let index = 0; index < model.vertex_count; index += 1) {
    vertices.set(
      model.vertices.subarray(index * 6, index * 6 + 6),
      index * 8,
    );
  }
  return Object.freeze({
    id,
    indices: Uint32Array.from(
      { length: model.vertex_count },
      (_, index) => index,
    ),
    material: default_material,
    vertices,
  });
}

function prepared_mesh_resource(
  asset: AssetId<"mesh">,
  prepared_id: string,
): Extract<AdventurePreparedResource, { type: "mesh" }> {
  return Object.freeze({ asset, prepared_id, type: "mesh" });
}

function prepared_texture_resource(
  asset: AssetId<"texture">,
  prepared_id: string,
): Extract<AdventurePreparedResource, { type: "texture" }> {
  return Object.freeze({ asset, prepared_id, type: "texture" });
}

function parse_resource(
  value: unknown,
  field: string,
  source: string,
): AdventurePreparedResource {
  const resource = expect_record(value, field, source);
  if (resource.type !== "mesh" && resource.type !== "texture") {
    throw new Error(
      `adventure render asset catalog ${JSON.stringify(source)} field ${
        JSON.stringify(`${field}.type`)
      } must be "mesh" or "texture"; found ${JSON.stringify(resource.type)}`,
    );
  }
  const asset = nonempty_string(resource.asset, `${field}.asset`, source);
  const prepared_id = nonempty_string(
    resource.prepared_id,
    `${field}.prepared_id`,
    source,
  );
  return resource.type === "mesh"
    ? Object.freeze({
      asset: asset_id<"mesh">(asset),
      prepared_id,
      type: "mesh",
    })
    : Object.freeze({
      asset: asset_id<"texture">(asset),
      prepared_id,
      type: "texture",
    });
}

function expect_record(
  value: unknown,
  field: string,
  source: string,
): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(
    `adventure render asset catalog ${JSON.stringify(source)} field ${
      JSON.stringify(field)
    } must be an object`,
  );
}

function nonempty_string(
  value: unknown,
  field: string,
  source: string,
): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  throw new Error(
    `adventure render asset catalog ${JSON.stringify(source)} field ${
      JSON.stringify(field)
    } must be a non-empty string`,
  );
}
