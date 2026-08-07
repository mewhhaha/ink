import type { RenderSnapshot, SceneObjectCommand } from "@ink/blot/protocol.ts";
import type { GizmoVisibility } from "./debugger.ts";

export interface GameGizmoObjectRange {
  readonly category: "collisions" | "areas";
  readonly first_object_id: number;
  readonly object_count: number;
  readonly box_mesh: number;
}

const edge_thickness = 30_000;
const edge_offset = 515_000;
const edge_length = 1_030_000;
const edge_transforms = [
  ...[-edge_offset, edge_offset].flatMap((y) =>
    [-edge_offset, edge_offset].map((z) => ({
      position: [0, y, z] as const,
      scale: [edge_length, edge_thickness, edge_thickness] as const,
    }))
  ),
  ...[-edge_offset, edge_offset].flatMap((x) =>
    [-edge_offset, edge_offset].map((z) => ({
      position: [x, 0, z] as const,
      scale: [edge_thickness, edge_length, edge_thickness] as const,
    }))
  ),
  ...[-edge_offset, edge_offset].flatMap((x) =>
    [-edge_offset, edge_offset].map((y) => ({
      position: [x, y, 0] as const,
      scale: [edge_thickness, edge_thickness, edge_length] as const,
    }))
  ),
] as const;

export function render_game_gizmos(
  snapshot: RenderSnapshot,
  ranges: readonly GameGizmoObjectRange[],
  visibility: GizmoVisibility,
): RenderSnapshot {
  validate_ranges(ranges);
  if (visibility === "none") return snapshot;
  if (
    visibility !== "all" && visibility !== "collisions" &&
    visibility !== "areas"
  ) {
    throw new Error(
      `game gizmo visibility ${JSON.stringify(visibility)} is unsupported`,
    );
  }

  const selected_ranges = ranges.filter((range) =>
    visibility === "all" || range.category === visibility
  );
  if (selected_ranges.length === 0) return snapshot;

  const mesh_ids = new Set(
    snapshot.resources.flatMap((resource) =>
      resource.type === "mesh" ? [resource.id] : []
    ),
  );
  for (const range of selected_ranges) {
    if (!mesh_ids.has(range.box_mesh)) {
      throw new Error(
        `${range.category} gizmo range selects missing box mesh ${range.box_mesh}`,
      );
    }
  }

  let next_object_id = Math.max(
    -1,
    ...snapshot.nodes.map(({ id }) => id),
    ...snapshot.objects.map(({ id }) => id),
  ) + 1;
  const gizmos: SceneObjectCommand[] = [];
  for (const range of selected_ranges) {
    const last_object_id = range.first_object_id + range.object_count;
    const sources = snapshot.objects.filter((object) =>
      object.visible && object.id >= range.first_object_id &&
      object.id < last_object_id
    );
    for (const source of sources) {
      for (const edge of edge_transforms) {
        if (!Number.isSafeInteger(next_object_id)) {
          throw new Error(
            "game gizmo scene object identities exceed safe integers",
          );
        }
        gizmos.push({
          type: "scene_object",
          id: next_object_id,
          mesh: range.box_mesh,
          parent: source.id,
          color: range.category === "areas" ? [0.25, 0.65, 1] : [0.2, 1, 0.45],
          emissive: 1,
          texture: null,
          texture_offset: [0, 0],
          secondary_texture: null,
          texture_scale: [1, 1],
          blend_edges: 0,
          variation_seed: 0,
          surface_mode: 0,
          path_connections: 0,
          rotation_radians: [0, 0, 0],
          position: edge.position,
          scale: edge.scale,
          visible: true,
        });
        next_object_id += 1;
      }
    }
  }
  if (gizmos.length === 0) return snapshot;
  return { ...snapshot, objects: [...snapshot.objects, ...gizmos] };
}

function validate_ranges(ranges: readonly GameGizmoObjectRange[]): void {
  for (const [index, range] of ranges.entries()) {
    if (range.category !== "collisions" && range.category !== "areas") {
      throw new Error(
        `game gizmo range ${index} category ${
          JSON.stringify(range.category)
        } must be collisions or areas`,
      );
    }
    if (
      !Number.isSafeInteger(range.first_object_id) ||
      range.first_object_id < 0
    ) {
      throw new Error(
        `game gizmo range ${index} first object id ${
          JSON.stringify(range.first_object_id)
        } must be a nonnegative safe integer`,
      );
    }
    if (!Number.isSafeInteger(range.object_count) || range.object_count <= 0) {
      throw new Error(
        `game gizmo range ${index} object count ${
          JSON.stringify(range.object_count)
        } must be a positive safe integer`,
      );
    }
    if (!Number.isSafeInteger(range.box_mesh) || range.box_mesh < 0) {
      throw new Error(
        `game gizmo range ${index} box mesh ${
          JSON.stringify(range.box_mesh)
        } must be a nonnegative safe integer`,
      );
    }
    if (!Number.isSafeInteger(range.first_object_id + range.object_count)) {
      throw new Error(
        `game gizmo range ${index} exceeds safe object identities`,
      );
    }
  }
}
