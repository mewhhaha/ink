import type { AssetId } from "@ink/assets/identity.ts";
import type { RenderingAnimationOutput } from "@ink/animation/adapters.ts";
import type { CameraView } from "@ink/camera/view.ts";
import type { LightingPlan } from "@ink/lighting/plan.ts";
import type { MaterialInstanceId } from "@ink/materials/identity.ts";
import type { Mat4 } from "@ink/math/matrix.ts";
import { scene_node_key, type SceneNodeId } from "@ink/scene/identity.ts";
import type { SceneSnapshot } from "@ink/scene/scene.ts";
import type { VisibleSet } from "@ink/visibility/model.ts";

export type RenderPhase = "opaque" | "alpha_mask" | "transparent";

export interface RenderableAttachment {
  readonly mesh: AssetId<"mesh">;
  readonly primitive: number;
  readonly material: MaterialInstanceId;
  readonly material_revision: number;
  readonly surface: string;
  readonly pipeline_key: string;
  readonly phase: RenderPhase;
  readonly casts_shadow: boolean;
  readonly receives_shadow: boolean;
  readonly skin_palette_revision?: number;
  readonly morph_weights_revision?: number;
}

export interface ExtractedRenderable {
  readonly node: SceneNodeId;
  readonly source_revision: number;
  readonly transform: Mat4;
  readonly renderable: RenderableAttachment;
  readonly lod: string;
  readonly views: readonly string[];
}

export interface RenderWorld {
  readonly scene_revision: number;
  readonly visible_revision: number;
  readonly material_revision: number;
  readonly light_revision: number;
  readonly transform_revision: number;
  readonly renderables: readonly ExtractedRenderable[];
  readonly lighting: LightingPlan;
}

export interface DrawPacket {
  readonly object: SceneNodeId;
  readonly mesh: AssetId<"mesh">;
  readonly primitive: number;
  readonly material: MaterialInstanceId;
  readonly material_revision: number;
  readonly pipeline_key: string;
  readonly phase: RenderPhase;
  readonly transform: Mat4;
  readonly view_depth: number;
  readonly lod: string;
  readonly sequence: number;
}

export interface InstanceBatch {
  readonly pipeline_key: string;
  readonly mesh: AssetId<"mesh">;
  readonly primitive: number;
  readonly material: MaterialInstanceId;
  readonly packets: readonly DrawPacket[];
}

export interface DeformationUpload {
  readonly object: SceneNodeId;
  readonly skin_palette_revision?: number;
  readonly morph_weights_revision?: number;
}

export interface PackedDeformationUpload extends DeformationUpload {
  readonly skin_matrices: Float32Array;
  readonly morph_weights: Float32Array;
  readonly morph_names: readonly string[];
}

export interface RenderExtractionInput {
  readonly scene: SceneSnapshot;
  readonly visible: VisibleSet;
  readonly material_revision: number;
  readonly transform_revision: number;
  readonly lighting: LightingPlan;
  readonly attachment_key?: string;
}

export function extract_render_world(
  input: RenderExtractionInput,
): RenderWorld {
  for (
    const [label, revision] of [["material", input.material_revision], [
      "light",
      input.lighting.revision,
    ], ["transform", input.transform_revision]] as const
  ) {
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new Error(
        `render extraction ${label} revision ${
          JSON.stringify(revision)
        } must be nonnegative`,
      );
    }
  }
  if (input.visible.input_revision < input.scene.revision) {
    throw new Error(
      `render visible revision ${input.visible.input_revision} is older than scene revision ${input.scene.revision}`,
    );
  }
  if (
    input.lighting.visibility_revision !== undefined &&
    input.lighting.visibility_revision !== input.visible.input_revision
  ) {
    throw new Error(
      `render lighting revision ${input.lighting.revision} references visibility ${input.lighting.visibility_revision}, expected ${input.visible.input_revision}`,
    );
  }
  const key = input.attachment_key ?? "renderable";
  const visible = new Map(
    input.visible.visible.map((record) => [String(record.id), record]),
  );
  const renderables: ExtractedRenderable[] = [];
  for (const node of input.scene.nodes) {
    if (!node.world_active) continue;
    const visibility = visible.get(scene_node_key(node.id));
    if (visibility === undefined) continue;
    const attachment = parse_renderable(node.attachments.get(key), node.id);
    if (attachment === undefined) continue;
    renderables.push(Object.freeze({
      node: node.id,
      source_revision: visibility.source_revision,
      transform: node.world_transform,
      renderable: attachment,
      lod: visibility.lod,
      views: [...visibility.views].sort(),
    }));
  }
  renderables.sort((left, right) =>
    scene_node_key(left.node).localeCompare(scene_node_key(right.node))
  );
  return Object.freeze({
    scene_revision: input.scene.revision,
    visible_revision: input.visible.input_revision,
    material_revision: input.material_revision,
    light_revision: input.lighting.revision,
    transform_revision: input.transform_revision,
    renderables,
    lighting: input.lighting,
  });
}

export function draw_packets(
  world: RenderWorld,
  view: CameraView,
): readonly DrawPacket[] {
  const packets = world.renderables
    .filter((renderable) => renderable.views.includes(String(view.camera)))
    .map((renderable, sequence): DrawPacket => ({
      object: renderable.node,
      mesh: renderable.renderable.mesh,
      primitive: renderable.renderable.primitive,
      material: renderable.renderable.material,
      material_revision: renderable.renderable.material_revision,
      pipeline_key: renderable.renderable.pipeline_key,
      phase: renderable.renderable.phase,
      transform: renderable.transform,
      view_depth: view_depth(renderable.transform, view.view_matrix),
      lod: renderable.lod,
      sequence,
    }));
  packets.sort(compare_draw_packets);
  return packets;
}

export function instance_batches(
  packets: readonly DrawPacket[],
): readonly InstanceBatch[] {
  const batches = new Map<string, DrawPacket[]>();
  for (const packet of packets) {
    if (packet.phase === "transparent") continue;
    const key =
      `${packet.pipeline_key}\u0000${packet.mesh}\u0000${packet.primitive}\u0000${packet.material}`;
    const batch = batches.get(key) ?? [];
    batch.push(packet);
    batches.set(key, batch);
  }
  return [...batches.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  ).map(([, packets]) => ({
    pipeline_key: packets[0].pipeline_key,
    mesh: packets[0].mesh,
    primitive: packets[0].primitive,
    material: packets[0].material,
    packets,
  }));
}

export function indirect_draw_arguments(
  batches: readonly InstanceBatch[],
  index_counts: ReadonlyMap<string, number>,
): Uint32Array {
  const output = new Uint32Array(batches.length * 5);
  for (const [index, batch] of batches.entries()) {
    const key = `${batch.mesh}:${batch.primitive}`;
    const index_count = index_counts.get(key);
    if (index_count === undefined) {
      throw new Error(
        `render indirect batch mesh primitive ${
          JSON.stringify(key)
        } has no index count`,
      );
    }
    output.set([index_count, batch.packets.length, 0, 0, 0], index * 5);
  }
  return output;
}

export function deformation_uploads(
  world: RenderWorld,
): readonly DeformationUpload[] {
  return world.renderables.flatMap((renderable) =>
    renderable.renderable.skin_palette_revision === undefined &&
      renderable.renderable.morph_weights_revision === undefined
      ? []
      : [{
        object: renderable.node,
        ...(renderable.renderable.skin_palette_revision === undefined ? {} : {
          skin_palette_revision: renderable.renderable.skin_palette_revision,
        }),
        ...(renderable.renderable.morph_weights_revision === undefined ? {} : {
          morph_weights_revision: renderable.renderable.morph_weights_revision,
        }),
      }]
  );
}

export function pack_deformation_upload(
  object: SceneNodeId,
  output: RenderingAnimationOutput,
  revisions: {
    readonly skin_palette_revision: number;
    readonly morph_weights_revision: number;
  },
): PackedDeformationUpload {
  for (
    const [label, revision] of [[
      "skin palette",
      revisions.skin_palette_revision,
    ], [
      "morph weights",
      revisions.morph_weights_revision,
    ]] as const
  ) {
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new Error(
        `render object ${scene_node_key(object)} ${label} revision ${
          JSON.stringify(revision)
        } must be nonnegative`,
      );
    }
  }
  const skin_matrices = new Float32Array(output.skin_matrices.length * 16);
  for (const [index, matrix] of output.skin_matrices.entries()) {
    skin_matrices.set(matrix, index * 16);
  }
  const morphs = [...output.morph_weights].sort(([left], [right]) =>
    left.localeCompare(right)
  );
  return {
    object,
    skin_palette_revision: revisions.skin_palette_revision,
    morph_weights_revision: revisions.morph_weights_revision,
    skin_matrices,
    morph_names: morphs.map(([name]) => name),
    morph_weights: new Float32Array(morphs.map(([, weight]) => weight)),
  };
}

function compare_draw_packets(left: DrawPacket, right: DrawPacket): number {
  const phase = phase_order(left.phase) - phase_order(right.phase);
  if (phase !== 0) return phase;
  if (left.phase === "transparent") {
    return right.view_depth - left.view_depth || left.sequence - right.sequence;
  }
  return left.pipeline_key.localeCompare(right.pipeline_key) ||
    String(left.material).localeCompare(String(right.material)) ||
    String(left.mesh).localeCompare(String(right.mesh)) ||
    left.view_depth - right.view_depth || left.sequence - right.sequence;
}

function phase_order(phase: RenderPhase): number {
  return phase === "opaque" ? 0 : phase === "alpha_mask" ? 1 : 2;
}

function view_depth(transform: Mat4, view: Mat4): number {
  const x = transform[12];
  const y = transform[13];
  const z = transform[14];
  return -(view[2] * x + view[6] * y + view[10] * z + view[14]);
}

function parse_renderable(
  value: unknown,
  node: SceneNodeId,
): RenderableAttachment | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) {
    throw new Error(
      `render node ${
        scene_node_key(node)
      } attachment "renderable" must be an object`,
    );
  }
  const candidate = value as Partial<RenderableAttachment>;
  if (
    typeof candidate.mesh !== "string" ||
    typeof candidate.material !== "string" ||
    typeof candidate.surface !== "string" ||
    typeof candidate.pipeline_key !== "string"
  ) {
    throw new Error(
      `render node ${
        scene_node_key(node)
      } attachment "renderable" lacks mesh, material, surface, or pipeline identity`,
    );
  }
  if (
    !Number.isSafeInteger(candidate.primitive) || candidate.primitive! < 0 ||
    !Number.isSafeInteger(candidate.material_revision) ||
    candidate.material_revision! < 0
  ) {
    throw new Error(
      `render node ${scene_node_key(node)} attachment has invalid primitive ${
        JSON.stringify(candidate.primitive)
      } or material revision ${JSON.stringify(candidate.material_revision)}`,
    );
  }
  if (
    candidate.phase !== "opaque" && candidate.phase !== "alpha_mask" &&
    candidate.phase !== "transparent"
  ) {
    throw new Error(
      `render node ${scene_node_key(node)} attachment phase ${
        JSON.stringify(candidate.phase)
      } is invalid`,
    );
  }
  if (
    typeof candidate.casts_shadow !== "boolean" ||
    typeof candidate.receives_shadow !== "boolean"
  ) {
    throw new Error(
      `render node ${
        scene_node_key(node)
      } attachment needs explicit shadow flags`,
    );
  }
  return Object.freeze({ ...candidate } as RenderableAttachment);
}
