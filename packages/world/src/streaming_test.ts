import type { AssetLease } from "@ink/assets/cache.ts";
import {
  artifact_revision,
  asset_id,
  type AssetId,
} from "@ink/assets/identity.ts";
import { scene_id } from "@ink/scene/identity.ts";
import type { ResolvedScene } from "@ink/scene/hierarchy.ts";
import { assertEquals } from "@std/assert";
import { cell_id, chunk_coordinate, level_id, world_id } from "./identity.ts";
import { create_grid_partition } from "./partition.ts";
import type {
  CellScenePublisher,
  ResidencyDemand,
  WorldAssetLeaseProvider,
} from "./streaming.ts";
import { ResidencyCoordinator } from "./streaming.ts";

interface LeaseTracking {
  readonly released: string[];
  unavailable?: AssetId;
  delayed?: AssetId;
}

function lease_provider(tracking: LeaseTracking): WorldAssetLeaseProvider {
  return {
    acquire(id, _priority, signal) {
      if (id === tracking.unavailable) {
        return Promise.resolve({ type: "unavailable", id, reason: "missing" });
      }
      if (id === tracking.delayed) {
        return new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve({ type: "cancelled", id }),
            { once: true },
          );
        });
      }
      let released = false;
      const lease: AssetLease = {
        id,
        revision: artifact_revision(`revision-${id}`),
        read: () => new Uint8Array([1]),
        release: () => {
          if (released) throw new Error(`lease ${id} released twice`);
          released = true;
          tracking.released.push(id);
        },
      };
      return Promise.resolve({ type: "ready", lease });
    },
  };
}

function fixture() {
  const dependency = asset_id("shared");
  const partition = create_grid_partition({
    world_id: world_id("world"),
    level_id: level_id("level"),
    cell_size: 10,
    cells: [0, 1, 2].map((x) => ({
      coordinate: chunk_coordinate(x, 0),
      scene_asset: asset_id<"scene">(`scene-${x}`),
      dependencies: [dependency],
      estimated_bytes: 10,
    })),
  });
  return { partition, dependency };
}

function publisher(
  published: string[],
  detached: string[],
): CellScenePublisher {
  return {
    publish: (cell) => {
      published.push(cell.id);
    },
    detach: (cell) => {
      detached.push(cell.id);
    },
  };
}

function demand(cell_id: string, distance_squared: number): ResidencyDemand {
  return {
    cell_id: cell_id as ResidencyDemand["cell_id"],
    priority: "visible",
    distance_squared,
  };
}

Deno.test("streaming publishes only complete cells and evicts by deterministic budget", async () => {
  const { partition } = fixture();
  const tracking: LeaseTracking = { released: [] };
  const published: string[] = [];
  const detached: string[] = [];
  const coordinator = new ResidencyCoordinator({
    partition,
    assets: lease_provider(tracking),
    decoder: {
      decode: (cell, scene, dependencies) => {
        assertEquals(scene.id, cell.scene_asset);
        assertEquals(dependencies.size, 1);
        return {
          id: scene_id(cell.id),
          revision: 1,
          nodes: [],
        };
      },
    },
    publisher: publisher(published, detached),
    budget: { maximum_cells: 2, maximum_estimated_bytes: 20 },
  });
  const first = await coordinator.reconcile([
    demand("level:0:0:0", 0),
    demand("level:1:0:0", 1),
    demand("level:2:0:0", 2),
  ]);
  assertEquals(first.resident_cells.map(({ cell_id }) => cell_id), [
    "level:0:0:0",
    "level:1:0:0",
  ]);
  assertEquals(first.budget_excluded, [cell_id("level:2:0:0")]);
  assertEquals(published, ["level:0:0:0", "level:1:0:0"]);

  await coordinator.reconcile([demand("level:2:0:0", 0)]);
  assertEquals(coordinator.resident().map(({ cell_id }) => cell_id), [
    "level:2:0:0",
  ]);
  assertEquals(detached, ["level:0:0:0", "level:1:0:0"]);
  assertEquals(
    tracking.released.sort(),
    [
      "scene-0",
      "scene-1",
      "shared",
      "shared",
    ].sort(),
  );
  await coordinator.close();
});

Deno.test("failed refresh retains the last complete cell revision", async () => {
  const { partition, dependency } = fixture();
  const tracking: LeaseTracking = { released: [] };
  const coordinator = new ResidencyCoordinator({
    partition,
    assets: lease_provider(tracking),
    decoder: {
      decode: (cell): ResolvedScene => ({
        id: scene_id(cell.id),
        revision: 1,
        nodes: [],
      }),
    },
    publisher: publisher([], []),
    budget: { maximum_cells: 3, maximum_estimated_bytes: 30 },
  });
  await coordinator.reconcile([demand("level:0:0:0", 0)]);
  tracking.unavailable = dependency;
  const refreshed = await coordinator.reconcile([{
    ...demand("level:0:0:0", 0),
    refresh: true,
  }]);
  assertEquals(refreshed.resident_cells.length, 1);
  assertEquals(refreshed.cells[0].type, "resident");
  await coordinator.close();
});

Deno.test("successful refresh detaches the previous scene before releasing its leases", async () => {
  const { partition } = fixture();
  const tracking: LeaseTracking = { released: [] };
  const detached_revisions: number[] = [];
  let revision = 0;
  const decoder = {
    decode: (cell: { readonly id: string }): ResolvedScene => ({
      id: scene_id(cell.id),
      revision: ++revision,
      nodes: [],
    }),
  };
  const configured = new ResidencyCoordinator({
    partition,
    assets: lease_provider(tracking),
    decoder,
    publisher: {
      publish: () => {},
      detach: (_cell, scene) => {
        detached_revisions.push(scene.revision);
      },
    },
    budget: { maximum_cells: 3, maximum_estimated_bytes: 30 },
  });
  await configured.reconcile([demand("level:0:0:0", 0)]);
  await configured.reconcile([{
    ...demand("level:0:0:0", 0),
    refresh: true,
  }]);
  assertEquals(detached_revisions, [1]);
  assertEquals(tracking.released.sort(), ["scene-0", "shared"].sort());
  await configured.close();
});

Deno.test("new demand cancels obsolete cell acquisition", async () => {
  const { partition } = fixture();
  const tracking: LeaseTracking = {
    released: [],
    delayed: asset_id("scene-0"),
  };
  const coordinator = new ResidencyCoordinator({
    partition,
    assets: lease_provider(tracking),
    decoder: {
      decode: (cell): ResolvedScene => ({
        id: scene_id(cell.id),
        revision: 1,
        nodes: [],
      }),
    },
    publisher: publisher([], []),
    budget: { maximum_cells: 3, maximum_estimated_bytes: 30 },
  });
  const obsolete = coordinator.reconcile([demand("level:0:0:0", 0)]);
  const current = coordinator.reconcile([demand("level:1:0:0", 0)]);
  assertEquals((await obsolete).cells[0].type, "cancelled");
  assertEquals((await current).resident_cells.map(({ cell_id }) => cell_id), [
    "level:1:0:0",
  ]);
  await coordinator.close();
});

Deno.test("obsolete publication rolls back without evicting current demand", async () => {
  const { partition } = fixture();
  let publication_started!: () => void;
  const started = new Promise<void>((resolve) => {
    publication_started = resolve;
  });
  let finish_publication!: () => void;
  const publication_gate = new Promise<void>((resolve) => {
    finish_publication = resolve;
  });
  const detached: string[] = [];
  const coordinator = new ResidencyCoordinator({
    partition,
    assets: lease_provider({ released: [] }),
    decoder: {
      decode: (cell): ResolvedScene => ({
        id: scene_id(cell.id),
        revision: 1,
        nodes: [],
      }),
    },
    publisher: {
      publish: (cell) => {
        if (cell.id !== "level:0:0:0") return;
        publication_started();
        return publication_gate;
      },
      detach: (cell) => {
        detached.push(cell.id);
      },
    },
    budget: { maximum_cells: 3, maximum_estimated_bytes: 30 },
  });
  const obsolete = coordinator.reconcile([demand("level:0:0:0", 0)]);
  await started;
  const current = await coordinator.reconcile([demand("level:1:0:0", 0)]);
  finish_publication();
  const cancelled = await obsolete;

  assertEquals(current.resident_cells.map(({ cell_id }) => cell_id), [
    "level:1:0:0",
  ]);
  assertEquals(cancelled.cells[0].type, "cancelled");
  assertEquals(coordinator.resident().map(({ cell_id }) => cell_id), [
    "level:1:0:0",
  ]);
  assertEquals(detached, ["level:0:0:0"]);
  await coordinator.close();
});

Deno.test("residency save restores deterministic blocking demands", async () => {
  const { partition } = fixture();
  const coordinator = new ResidencyCoordinator({
    partition,
    assets: lease_provider({ released: [] }),
    decoder: {
      decode: (cell): ResolvedScene => ({
        id: scene_id(cell.id),
        revision: 1,
        nodes: [],
      }),
    },
    publisher: publisher([], []),
    budget: { maximum_cells: 3, maximum_estimated_bytes: 30 },
  });
  await coordinator.reconcile([demand("level:2:0:0", 0)]);
  assertEquals(coordinator.restore_demands(coordinator.save()), [{
    cell_id: cell_id("level:2:0:0"),
    priority: "blocking",
    distance_squared: 0,
  }]);
  await coordinator.close();
});
