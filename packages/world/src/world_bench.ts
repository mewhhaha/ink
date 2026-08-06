import type { AssetLease } from "@ink/assets/cache.ts";
import { artifact_revision, asset_id } from "@ink/assets/identity.ts";
import { vec3 } from "@ink/math/vector.ts";
import { scene_id } from "@ink/scene/identity.ts";
import {
  chunk_coordinate,
  global_position,
  level_id,
  world_id,
} from "./identity.ts";
import { create_grid_partition } from "./partition.ts";
import { create_spatial_demand, ResidencyCoordinator } from "./streaming.ts";
import { create_terrain, edit_terrain, mesh_terrain_chunk } from "./terrain.ts";

const partition_width = 100;
const large_partition = create_grid_partition({
  world_id: world_id("benchmark"),
  level_id: level_id("surface"),
  cell_size: 32,
  cells: Array.from({ length: partition_width ** 2 }, (_, index) => ({
    coordinate: chunk_coordinate(
      index % partition_width,
      Math.floor(index / partition_width),
    ),
    scene_asset: asset_id<"scene">(`scene-${index}`),
    estimated_bytes: 1_024,
  })),
});

Deno.bench("calculate demand over a 10,000-cell static partition", () => {
  const demands = create_spatial_demand(large_partition, {
    focus: global_position(50, 50, vec3(16, 0, 16), 32),
    visible_distance: 256,
    prefetch_distance: 512,
    lod_distances: [128, 256],
  });
  if (demands.length === 0) throw new Error("static demand is empty");
});

const camera_path = Array.from(
  { length: 100 },
  (_, index) => global_position(index, 50, vec3(16, 0, 16), 32),
);

Deno.bench("calculate demand for a 100-cell moving-camera traversal", () => {
  let demanded_cells = 0;
  for (const focus of camera_path) {
    demanded_cells += create_spatial_demand(large_partition, {
      focus,
      visible_distance: 96,
      prefetch_distance: 160,
    }).length;
  }
  if (demanded_cells === 0) throw new Error("camera traversal demand is empty");
});

const terrain_width = 257;
const terrain = create_terrain({
  origin: global_position(0, 0, vec3(0, 0, 0), 256),
  width: terrain_width,
  depth: terrain_width,
  spacing: 1,
  heights: new Float32Array(terrain_width ** 2),
});
const terrain_edits = Array.from({ length: 1_000 }, (_, index) => ({
  type: "set_height" as const,
  x: index % 256,
  z: Math.floor(index / 256),
  height: index % 17,
}));

Deno.bench("edit 1,000 terrain samples and rebuild one 64-quad chunk", () => {
  const edited = edit_terrain(terrain, terrain_edits, { chunk_quads: 64 });
  const mesh = mesh_terrain_chunk(
    edited.terrain,
    chunk_coordinate(0, 0),
    { chunk_quads: 64, skirt_depth: 2 },
  );
  if (mesh.indices.length === 0) throw new Error("terrain mesh is empty");
});

const memory_pressure_demands = large_partition.cells().map((cell, index) => ({
  cell_id: cell.id,
  priority: "visible" as const,
  distance_squared: index,
  refresh: true,
}));
const coordinator = new ResidencyCoordinator({
  partition: large_partition,
  assets: {
    acquire(id) {
      const lease: AssetLease = {
        id,
        revision: artifact_revision("benchmark-revision"),
        read: () => new Uint8Array(),
        release: () => {},
      };
      return Promise.resolve({ type: "ready", lease });
    },
  },
  decoder: {
    decode: (cell) => ({
      scene_id: scene_id(cell.id),
      revision: 1,
      nodes: [],
    }),
  },
  publisher: {
    publish: () => {},
    detach: () => {},
  },
  budget: { maximum_cells: 64, maximum_estimated_bytes: 64 * 1_024 },
});

Deno.bench(
  "reconcile 10,000 cells against a 64-cell memory budget",
  async () => {
    const result = await coordinator.reconcile(memory_pressure_demands);
    if (result.budget_excluded.length !== 9_936) {
      throw new Error(
        `memory-pressure benchmark excluded ${result.budget_excluded.length} cells`,
      );
    }
  },
);
