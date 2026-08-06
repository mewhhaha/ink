import { assertEquals } from "@std/assert";
import { build_camera_frame } from "@ink/camera/view.ts";
import { camera_id, type CameraDefinition } from "@ink/camera/model.ts";
import { aabb } from "@ink/geometry/shapes.ts";
import { quat_identity } from "@ink/math/quaternion.ts";
import { vec3 } from "@ink/math/vector.ts";
import { cell_id } from "@ink/world/identity.ts";
import type { WorldPartition } from "@ink/world/partition.ts";
import {
  visibility_id,
  visibility_object,
  type VisibilityObject,
} from "./model.ts";
import { ingest_occlusion_batch, software_occlusion } from "./occlusion.ts";
import { select_lod, VisibilityPipeline } from "./pipeline.ts";
import { traverse_visible_cells } from "./portals.ts";

Deno.test("CPU visibility retains every object inside the exhaustive camera oracle", () => {
  const view = fixture_view();
  const objects = Array.from({ length: 25 }, (_, index) => {
    const x = index % 5 - 2;
    const y = Math.floor(index / 5) - 2;
    return object(
      `${x}:${y}`,
      aabb(
        vec3(x - 0.1, y - 0.1, -5.1),
        vec3(x + 0.1, y + 0.1, -4.9),
      ),
    );
  });
  const result = new VisibilityPipeline().evaluate(objects, context(view, 1));
  assertEquals(
    result.visible.map((entry) => entry.id),
    objects.map((entry) => entry.id).sort(),
  );
});

Deno.test("CPU stages attribute layer, distance, frustum, and projected-size rejection", () => {
  const view = fixture_view();
  const objects = [
    { ...object("layer", box(0, 0, -5)), layers: 0 },
    { ...object("distance", box(0, 0, -5)), maximum_distance: 1 },
    object("frustum", box(100, 0, -5)),
    { ...object("small", box(0, 0, -50, 0.01)), minimum_projected_pixels: 2 },
  ].map(visibility_object);
  const result = new VisibilityPipeline().evaluate(objects, context(view, 1));
  assertEquals(result.rejected.map((entry) => [entry.id, entry.reason]), [
    ["distance", "distance"],
    ["frustum", "frustum"],
    ["layer", "layer"],
    ["small", "projected_size"],
  ]);
});

Deno.test("stale, reduced-confidence, newly-visible, fast-mover, and cut occlusion stay visible", () => {
  const view = fixture_view();
  const still = object("still", box(0, 0, -5));
  const moving = {
    ...object("moving", box(0, 0, -5)),
    velocity: vec3(10, 0, 0),
  };
  const previous = new VisibilityPipeline().evaluate(
    [still, moving],
    context(view, 1),
  );
  const occlusion = new Map([
    [still.id, {
      type: "occluded" as const,
      revision: 1,
      confidence: "certain" as const,
    }],
    [moving.id, {
      type: "occluded" as const,
      revision: 2,
      confidence: "certain" as const,
    }],
  ]);
  const result = new VisibilityPipeline().evaluate([still, moving], {
    ...context(view, 2),
    previous,
    occlusion,
  });
  assertEquals(result.visible.map((entry) => entry.id), ["moving", "still"]);
  const cut = new VisibilityPipeline().evaluate([still], {
    ...context(view, 1),
    previous,
    occlusion,
    camera_cut: true,
  });
  assertEquals(cut.visible.length, 1);
});

Deno.test("certain matching occlusion rejects a previously visible stationary object", () => {
  const view = fixture_view();
  const candidate = object("candidate", box(0, 0, -6));
  const previous = new VisibilityPipeline().evaluate(
    [candidate],
    context(view, 1),
  );
  const result = new VisibilityPipeline().evaluate([candidate], {
    ...context(view, 2),
    previous,
    occlusion: new Map([[
      candidate.id,
      { type: "occluded", revision: 2, confidence: "certain" },
    ]]),
  });
  assertEquals(result.rejected[0].reason, "occlusion");
});

Deno.test("software occlusion hides covered geometry and reports reduced resolution", () => {
  const view = fixture_view();
  const wall = {
    ...object("wall", aabb(vec3(-2, -2, -4), vec3(2, 2, -3))),
    occluder: true,
  };
  const hidden = object("hidden", box(0, 0, -6));
  const full = software_occlusion({
    input_revision: 4,
    view,
    raster: { width: 100, height: 100 },
    occluders: [wall],
    objects: [wall, hidden],
  });
  assertEquals(full.states.get(hidden.id), {
    type: "occluded",
    revision: 4,
    confidence: "certain",
  });
  const reduced = software_occlusion({
    input_revision: 4,
    view,
    raster: { width: 25, height: 25 },
    occluders: [wall],
    objects: [hidden],
  });
  assertEquals(reduced.states.get(hidden.id), {
    type: "occluded",
    revision: 4,
    confidence: "reduced",
  });
});

Deno.test("occlusion ingestion tags delayed results as stale and camera cuts as invalidated", () => {
  const id = visibility_id("fixture");
  const batch = {
    input_revision: 2,
    states: new Map([[id, {
      type: "occluded" as const,
      revision: 2,
      confidence: "certain" as const,
    }]]),
  };
  assertEquals(ingest_occlusion_batch(batch, 3).get(id), {
    type: "stale",
    revision: 2,
    expected_revision: 3,
  });
  assertEquals(ingest_occlusion_batch(batch, 2, { camera_cut: true }).get(id), {
    type: "invalidated",
    revision: 2,
    reason: "camera cut",
  });
});

Deno.test("LOD hysteresis prevents threshold oscillation", () => {
  const lods = [
    { id: "high", minimum_projected_pixels: 100 },
    { id: "low", minimum_projected_pixels: 0 },
  ];
  assertEquals(select_lod(lods, 95, "high", 0.1), "high");
  assertEquals(select_lod(lods, 89, "high", 0.1), "low");
  assertEquals(select_lod(lods, 105, "low", 0.1), "low");
  assertEquals(select_lod(lods, 111, "low", 0.1), "high");
});

Deno.test("portal traversal falls back conservatively when its depth is incomplete", () => {
  const first = cell_id("first");
  const second = cell_id("second");
  const cells = new Map([[first, { id: first }], [second, { id: second }]]);
  const partition = {
    cell: (id: typeof first) => cells.get(id),
    connected: (id: typeof first) => id === first ? [second] : [],
  } as unknown as WorldPartition;
  assertEquals(traverse_visible_cells(partition, [first], 0), {
    type: "fallback",
    reason: 'portal traversal from ["first"] exceeds depth 0',
  });
  const complete = traverse_visible_cells(partition, [first], 1);
  if (complete.type !== "complete") throw new Error(complete.reason);
  assertEquals([...complete.cells], [first, second]);
});

function fixture_view() {
  const camera: CameraDefinition = {
    id: camera_id("main"),
    pose: { position: vec3(0, 0, 0), rotation: quat_identity() },
    projection: {
      type: "perspective",
      vertical_fov_radians: Math.PI / 2,
      near: 0.1,
      far: 100,
      depth: "reversed",
    },
    viewport: { x: 0, y: 0, width: 1, height: 1 },
    layers: 1,
    order: 0,
    clear: { type: "load" },
  };
  const result = build_camera_frame({
    camera,
    surface: { width: 100, height: 100 },
    frame_index: 0,
  });
  if (result.type !== "ready") throw new Error(result.reason);
  return result.frame.view;
}

function object(id: string, bounds: ReturnType<typeof aabb>): VisibilityObject {
  return visibility_object({
    id: visibility_id(id),
    bounds,
    layers: 1,
    revision: 1,
    lods: [
      { id: "high", minimum_projected_pixels: 20 },
      { id: "low", minimum_projected_pixels: 0 },
    ],
    occluder: false,
  });
}

function box(x: number, y: number, z: number, radius = 0.5) {
  return aabb(
    vec3(x - radius, y - radius, z - radius),
    vec3(x + radius, y + radius, z + radius),
  );
}

function context(view: ReturnType<typeof fixture_view>, revision: number) {
  return {
    revision,
    views: [view],
    policy: {
      lod_hysteresis_ratio: 0.1,
      motion_expansion_seconds: 0.1,
      maximum_portal_depth: 8,
    },
  };
}
