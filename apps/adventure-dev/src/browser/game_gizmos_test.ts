import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import { asset_id } from "@ink/assets/identity.ts";
import type { RenderSnapshot } from "@ink/blot/protocol.ts";
import {
  type GameGizmoObjectRange,
  render_game_gizmos,
} from "./game_gizmos.ts";

const scene_object = {
  type: "scene_object",
  mesh: 0,
  parent: null,
  color: [1, 1, 1],
  emissive: 0,
  texture: null,
  texture_offset: [0, 0],
  secondary_texture: null,
  texture_scale: [1, 1],
  blend_edges: 0,
  variation_seed: 0,
  surface_mode: 0,
  path_connections: 0,
  rotation_radians: [0, 0, 0],
  position: [0, 0, 0],
  scale: [1_000_000, 1_000_000, 1_000_000],
  visible: true,
} as const;

const snapshot: RenderSnapshot = {
  projection: "orthographic",
  camera_zoom: 1,
  directional_light: {
    type: "directional_light",
    color: [1, 1, 1],
    direction: [0, 0, -1],
    intensity: 0,
  },
  nodes: [],
  objects: [
    { ...scene_object, id: 10 },
    { ...scene_object, id: 11, visible: false },
    { ...scene_object, id: 20 },
  ],
  resources: [{
    type: "mesh",
    id: 0,
    asset: asset_id<"mesh">("cube.obj"),
  }],
};

const ranges: readonly GameGizmoObjectRange[] = [
  {
    category: "collisions",
    first_object_id: 10,
    object_count: 2,
    box_mesh: 0,
  },
  {
    category: "areas",
    first_object_id: 20,
    object_count: 1,
    box_mesh: 0,
  },
];

Deno.test("adventure gizmos outline visible scene objects by category", () => {
  const collisions = render_game_gizmos(snapshot, ranges, "collisions");
  assertEquals(collisions.objects.length, snapshot.objects.length + 12);
  assertEquals(
    collisions.objects.slice(3).map(({ parent }) => parent),
    Array(12).fill(10),
  );
  assertEquals(collisions.objects[3].color, [0.2, 1, 0.45]);

  const all = render_game_gizmos(snapshot, ranges, "all");
  assertEquals(all.objects.length, snapshot.objects.length + 24);
  assertEquals(all.objects.at(-1)?.parent, 20);
  assertEquals(all.objects.at(-1)?.color, [0.25, 0.65, 1]);
});

Deno.test("disabled game gizmos preserve the original render snapshot", () => {
  assertStrictEquals(render_game_gizmos(snapshot, ranges, "none"), snapshot);
});

Deno.test("game gizmo ranges reject missing box meshes with evidence", () => {
  assertThrows(
    () => render_game_gizmos(snapshot, [{ ...ranges[0], box_mesh: 7 }], "all"),
    Error,
    "collisions gizmo range selects missing box mesh 7",
  );
});
