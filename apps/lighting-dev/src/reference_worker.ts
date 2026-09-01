import type { StaticGltfScene } from "@ink/assets/prepared_scene.ts";
import type { RenderTexture } from "@ink/rendering/renderer.ts";
import { LightingReferenceAssets } from "./reference_assets.ts";
import type {
  ReferenceLoadRequest,
  ReferenceLoadResponse,
} from "./reference_worker_protocol.ts";
import {
  prepare_lighting_reference,
  reference_texture_id,
  type ReferenceTextureUsage,
} from "./scene.ts";

interface LightingWorkerScope {
  onmessage: ((event: MessageEvent<ReferenceLoadRequest>) => void) | null;
  postMessage(message: ReferenceLoadResponse, transfer: Transferable[]): void;
}

const worker_scope = globalThis as unknown as LightingWorkerScope;
const reference_assets = LightingReferenceAssets.create();

worker_scope.onmessage = (event) => {
  void load_reference(event.data);
};

async function load_reference(request: ReferenceLoadRequest): Promise<void> {
  const started = performance.now();
  try {
    const { scene, source_materials } = await (await reference_assets).load(
      request.reference,
    );
    const textures = await decode_reference_textures(scene);
    let model;
    try {
      model = prepare_lighting_reference(scene, request.reference, textures);
    } catch (error) {
      for (const source of new Set(textures.map(({ source }) => source))) {
        source.close();
      }
      throw error;
    }
    const response: ReferenceLoadResponse = {
      loaded: {
        load_milliseconds: performance.now() - started,
        model,
        source_materials,
      },
      request_id: request.request_id,
      type: "loaded",
    };
    const transfer: Transferable[] = [
      ...model.meshes.flatMap(({ indices, vertices }) => [
        indices.buffer as ArrayBuffer,
        vertices.buffer as ArrayBuffer,
      ]),
      ...new Set(model.textures.map(({ source }) => source)),
    ];
    worker_scope.postMessage(response, transfer);
  } catch (error) {
    worker_scope.postMessage({
      reason: error instanceof Error ? error.message : String(error),
      request_id: request.request_id,
      type: "failed",
    }, []);
  }
}

async function decode_reference_textures(
  scene: StaticGltfScene,
): Promise<RenderTexture[]> {
  const usages = texture_usages(scene);
  const requested = scene.textures.filter(({ id }) => usages.has(id));
  const decoded = await Promise.allSettled(requested.map(async (texture) => ({
    source: await createImageBitmap(
      new Blob([texture.bytes.slice().buffer], { type: texture.mime_type }),
    ),
    texture,
  })));
  const failure = decoded.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") {
    for (const result of decoded) {
      if (result.status === "fulfilled") result.value.source.close();
    }
    throw failure.reason;
  }
  const textures: RenderTexture[] = [];
  for (const result of decoded) {
    if (result.status !== "fulfilled") continue;
    for (const usage of usages.get(result.value.texture.id) ?? []) {
      textures.push({
        color_space: usage === "base-color" ? "srgb" : "linear",
        id: reference_texture_id(result.value.texture.id, usage),
        source: result.value.source,
      });
    }
  }
  return textures;
}

function texture_usages(
  scene: StaticGltfScene,
): ReadonlyMap<string, ReadonlySet<ReferenceTextureUsage>> {
  const usages = new Map<string, Set<ReferenceTextureUsage>>();
  for (const { material } of scene.meshes) {
    add_texture_usage(usages, material.base_color_texture, "base-color");
    add_texture_usage(usages, material.normal_texture, "normal");
  }
  return usages;
}

function add_texture_usage(
  usages: Map<string, Set<ReferenceTextureUsage>>,
  texture: string | undefined,
  usage: ReferenceTextureUsage,
): void {
  if (texture === undefined) return;
  const current = usages.get(texture);
  if (current === undefined) usages.set(texture, new Set([usage]));
  else current.add(usage);
}
