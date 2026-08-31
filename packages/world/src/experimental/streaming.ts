import type { AssetLease } from "@ink/assets/cache.ts";
import type { AssetId, AssetPriority } from "@ink/assets/identity.ts";
import type { ArtifactRevision } from "@ink/assets/identity.ts";
import type { Observer } from "@ink/observability/observer.ts";
import type { ResolvedScene } from "@ink/scene/hierarchy.ts";
import { cell_id, type CellId, type GlobalPosition } from "../identity.ts";
import type { PartitionCell, WorldPartition } from "./partition.ts";

export type WorldLeaseResult =
  | { readonly type: "ready"; readonly lease: AssetLease }
  | { readonly type: "cancelled"; readonly id: AssetId }
  | {
    readonly type: "unavailable";
    readonly id: AssetId;
    readonly reason: string;
  };

export interface WorldAssetLeaseProvider {
  acquire(
    id: AssetId,
    priority: AssetPriority,
    signal: AbortSignal,
  ): Promise<WorldLeaseResult>;
}

export interface CellSceneDecoder {
  decode(
    cell: PartitionCell,
    scene: AssetLease,
    dependencies: ReadonlyMap<AssetId, AssetLease>,
  ): ResolvedScene | Promise<ResolvedScene>;
}

export interface CellScenePublisher {
  publish(cell: PartitionCell, snapshot: ResolvedScene): void | Promise<void>;
  detach(cell: PartitionCell, snapshot: ResolvedScene): void | Promise<void>;
}

export interface ResidencyDemand {
  readonly cell_id: CellId;
  readonly priority: AssetPriority;
  readonly distance_squared: number;
  readonly refresh?: boolean;
}

export interface ResidencyBudget {
  readonly maximum_cells: number;
  readonly maximum_estimated_bytes: number;
}

export interface ResidentCell {
  readonly cell_id: CellId;
  readonly scene_revision: ArtifactRevision;
  readonly scene: ResolvedScene;
  readonly estimated_bytes: number;
}

export type CellResidencyState =
  | { readonly type: "resident"; readonly cell: ResidentCell }
  | {
    readonly type: "unavailable";
    readonly cell_id: CellId;
    readonly reason: string;
  }
  | { readonly type: "cancelled"; readonly cell_id: CellId }
  | { readonly type: "evicted"; readonly cell_id: CellId };

export interface ResidencyResult {
  readonly generation: number;
  readonly cells: readonly CellResidencyState[];
  readonly resident_cells: readonly ResidentCell[];
  readonly estimated_bytes: number;
  readonly budget_excluded: readonly CellId[];
}

export interface ResidencyCoordinatorOptions {
  readonly partition: WorldPartition;
  readonly assets: WorldAssetLeaseProvider;
  readonly decoder: CellSceneDecoder;
  readonly publisher: CellScenePublisher;
  readonly budget: ResidencyBudget;
  readonly observer?: Observer;
}

interface ResidentRecord {
  readonly cell: PartitionCell;
  readonly scene: ResolvedScene;
  readonly leases: readonly AssetLease[];
}

interface PreparedCell {
  readonly demand: ResidencyDemand;
  readonly cell: PartitionCell;
  readonly leases: readonly AssetLease[];
  readonly scene: ResolvedScene;
}

const priority_rank: Readonly<Record<AssetPriority, number>> = {
  blocking: 0,
  visible: 1,
  background: 2,
};

export class ResidencyCoordinator {
  readonly #partition: WorldPartition;
  readonly #assets: WorldAssetLeaseProvider;
  readonly #decoder: CellSceneDecoder;
  readonly #publisher: CellScenePublisher;
  readonly #budget: ResidencyBudget;
  readonly #observer: Observer | undefined;
  readonly #resident = new Map<CellId, ResidentRecord>();
  #generation = 0;
  #active_loads: AbortController | undefined;
  #closed = false;

  constructor(options: ResidencyCoordinatorOptions) {
    this.#partition = options.partition;
    this.#assets = options.assets;
    this.#decoder = options.decoder;
    this.#publisher = options.publisher;
    this.#budget = parse_budget(options.budget);
    this.#observer = options.observer;
  }

  resident(): readonly ResidentCell[] {
    return [...this.#resident.values()]
      .sort((left, right) => left.cell.id.localeCompare(right.cell.id))
      .map((record) => resident_cell(record));
  }

  async reconcile(
    demands: readonly ResidencyDemand[],
  ): Promise<ResidencyResult> {
    if (this.#closed) throw new Error("world residency coordinator is closed");
    this.#active_loads?.abort();
    const cancellation = new AbortController();
    this.#active_loads = cancellation;
    const generation = this.#generation + 1;
    this.#generation = generation;
    const selected = select_demands(this.#partition, demands, this.#budget);
    this.#observer?.event("world.residency.demand", {
      generation,
      requested_cells: demands.length,
      selected_cells: selected.demands.length,
      excluded_cells: selected.excluded.length,
    });
    if (selected.excluded.length > 0) {
      this.#observer?.event("world.residency.budget_pressure", {
        generation,
        excluded_cells: selected.excluded.length,
        maximum_cells: this.#budget.maximum_cells,
        maximum_estimated_bytes: this.#budget.maximum_estimated_bytes,
      });
    }

    const prepared_results = await Promise.all(
      selected.demands.map(async (demand) => {
        const current = this.#resident.get(demand.cell_id);
        if (current !== undefined && demand.refresh !== true) {
          return { type: "current" as const, demand, current };
        }
        return await this.#prepare(demand, cancellation.signal);
      }),
    );
    if (this.#generation !== generation || cancellation.signal.aborted) {
      for (const prepared of prepared_results) {
        if (prepared.type === "prepared") release_leases(prepared.value.leases);
      }
      return this.#result(
        generation,
        prepared_results.map((prepared) => ({
          type: "cancelled" as const,
          cell_id: prepared.demand.cell_id,
        })),
        selected.excluded,
      );
    }

    const states: CellResidencyState[] = [];
    for (const prepared of prepared_results) {
      if (this.#generation !== generation || cancellation.signal.aborted) {
        if (prepared.type === "prepared") {
          release_leases(prepared.value.leases);
        }
        states.push({
          type: "cancelled",
          cell_id: prepared.demand.cell_id,
        });
        continue;
      }
      if (prepared.type === "current") {
        states.push({
          type: "resident",
          cell: resident_cell(prepared.current),
        });
        continue;
      }
      if (prepared.type !== "prepared") {
        const previous = this.#resident.get(prepared.demand.cell_id);
        if (previous !== undefined) {
          this.#observer?.event("world.residency.revision_retained", {
            cell_id: previous.cell.id,
            scene_revision: previous.leases[0].revision,
            generation,
          });
        }
        states.push(
          previous === undefined
            ? prepared.state
            : { type: "resident", cell: resident_cell(previous) },
        );
        continue;
      }
      const previous = this.#resident.get(prepared.value.cell.id);
      try {
        await this.#publisher.publish(
          prepared.value.cell,
          prepared.value.scene,
        );
      } catch (error) {
        release_leases(prepared.value.leases);
        const reason = `cell ${
          JSON.stringify(prepared.value.cell.id)
        } scene publish failed: ${error_reason(error)}`;
        states.push(
          previous === undefined
            ? { type: "unavailable", cell_id: prepared.value.cell.id, reason }
            : { type: "resident", cell: resident_cell(previous) },
        );
        this.#observer?.diagnostic(
          "error",
          "world.residency.publish",
          reason,
          { cell_id: prepared.value.cell.id, generation },
        );
        continue;
      }
      if (
        this.#generation !== generation || cancellation.signal.aborted ||
        this.#closed
      ) {
        try {
          await this.#publisher.detach(
            prepared.value.cell,
            prepared.value.scene,
          );
        } finally {
          release_leases(prepared.value.leases);
        }
        states.push({ type: "cancelled", cell_id: prepared.value.cell.id });
        continue;
      }
      if (previous !== undefined) {
        try {
          await this.#publisher.detach(previous.cell, previous.scene);
        } catch (error) {
          const rollback_failures: unknown[] = [];
          try {
            await this.#publisher.detach(
              prepared.value.cell,
              prepared.value.scene,
            );
          } catch (rollback_error) {
            rollback_failures.push(rollback_error);
          }
          try {
            release_leases(prepared.value.leases);
          } catch (release_error) {
            rollback_failures.push(release_error);
          }
          if (rollback_failures.length > 0) {
            throw new AggregateError(
              [error, ...rollback_failures],
              `cell ${
                JSON.stringify(previous.cell.id)
              } previous scene detach failed and replacement rollback was incomplete`,
            );
          }
          const reason = `cell ${
            JSON.stringify(previous.cell.id)
          } previous scene detach failed: ${error_reason(error)}`;
          states.push({ type: "resident", cell: resident_cell(previous) });
          this.#observer?.diagnostic(
            "error",
            "world.residency.detach",
            reason,
            { cell_id: previous.cell.id, generation },
          );
          continue;
        }
      }
      this.#resident.set(prepared.value.cell.id, {
        cell: prepared.value.cell,
        scene: prepared.value.scene,
        leases: prepared.value.leases,
      });
      if (previous !== undefined) release_leases(previous.leases);
      const resident = resident_cell(
        this.#resident.get(prepared.value.cell.id)!,
      );
      states.push({ type: "resident", cell: resident });
      this.#observer?.event("world.residency.published", {
        cell_id: resident.cell_id,
        scene_revision: resident.scene_revision,
        estimated_bytes: resident.estimated_bytes,
      });
    }

    if (this.#generation !== generation || cancellation.signal.aborted) {
      return this.#result(generation, states, selected.excluded);
    }

    const selected_ids = new Set(
      selected.demands.map(({ cell_id }) => cell_id),
    );
    for (
      const record of [...this.#resident.values()].sort((left, right) =>
        left.cell.id.localeCompare(right.cell.id)
      )
    ) {
      if (selected_ids.has(record.cell.id)) continue;
      try {
        await this.#publisher.detach(record.cell, record.scene);
      } catch (error) {
        this.#observer?.diagnostic(
          "error",
          "world.residency.detach",
          `cell ${JSON.stringify(record.cell.id)} detach failed`,
          { cell_id: record.cell.id, reason: error_reason(error) },
        );
        continue;
      }
      this.#resident.delete(record.cell.id);
      release_leases(record.leases);
      states.push({ type: "evicted", cell_id: record.cell.id });
      this.#observer?.event("world.residency.evicted", {
        cell_id: record.cell.id,
      });
    }
    return this.#result(generation, states, selected.excluded);
  }

  save(): string {
    const cells = [...this.#resident.values()]
      .sort((left, right) => left.cell.id.localeCompare(right.cell.id))
      .map((record) => ({
        id: record.cell.id,
        scene_revision: record.leases[0].revision,
      }));
    return JSON.stringify({
      format: "ink-world-residency",
      version: 1,
      world: this.#partition.world_id,
      level: this.#partition.level_id,
      cells,
    });
  }

  restore_demands(source: string): readonly ResidencyDemand[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch (cause) {
      throw new Error("world residency save is not valid JSON", { cause });
    }
    if (
      !is_record(parsed) || parsed.format !== "ink-world-residency" ||
      parsed.version !== 1 || parsed.world !== this.#partition.world_id ||
      parsed.level !== this.#partition.level_id || !Array.isArray(parsed.cells)
    ) {
      throw new Error(
        `world residency save does not match world ${
          JSON.stringify(this.#partition.world_id)
        } level ${JSON.stringify(this.#partition.level_id)}`,
      );
    }
    return Object.freeze(parsed.cells.map((entry, index) => {
      if (
        !is_record(entry) || typeof entry.id !== "string" ||
        typeof entry.scene_revision !== "string"
      ) {
        throw new Error(`world residency save cell ${index} is malformed`);
      }
      const cell = this.#partition.cell(entry.id as CellId);
      if (cell === undefined) {
        throw new Error(
          `world residency save cell ${
            JSON.stringify(entry.id)
          } is absent from the partition`,
        );
      }
      return {
        cell_id: cell.id,
        priority: "blocking" as const,
        distance_squared: index,
      };
    }));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#generation += 1;
    this.#active_loads?.abort();
    const failures: unknown[] = [];
    for (
      const record of [...this.#resident.values()].sort((left, right) =>
        left.cell.id.localeCompare(right.cell.id)
      )
    ) {
      try {
        await this.#publisher.detach(record.cell, record.scene);
      } catch (error) {
        failures.push(error);
      }
      try {
        release_leases(record.leases);
      } catch (error) {
        failures.push(error);
      }
      this.#resident.delete(record.cell.id);
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `world residency close failed for ${failures.length} resource operations`,
      );
    }
  }

  async #prepare(
    demand: ResidencyDemand,
    signal: AbortSignal,
  ): Promise<
    | {
      readonly type: "prepared";
      readonly demand: ResidencyDemand;
      readonly value: PreparedCell;
    }
    | {
      readonly type: "failed";
      readonly demand: ResidencyDemand;
      readonly state: CellResidencyState;
    }
  > {
    const cell = this.#partition.cell(demand.cell_id)!;
    const asset_ids = [cell.scene_asset, ...cell.dependencies];
    const leases: AssetLease[] = [];
    for (const id of asset_ids) {
      this.#observer?.event("world.residency.lease_requested", {
        cell_id: cell.id,
        asset_id: id,
        priority: demand.priority,
      });
      const acquired = await this.#assets.acquire(id, demand.priority, signal);
      if (acquired.type !== "ready") {
        release_leases(leases);
        this.#observer?.event(`world.residency.lease_${acquired.type}`, {
          cell_id: cell.id,
          asset_id: acquired.id,
          ...(acquired.type === "unavailable"
            ? { reason: acquired.reason }
            : {}),
        });
        return {
          type: "failed",
          demand,
          state: acquired.type === "cancelled"
            ? { type: "cancelled", cell_id: cell.id }
            : {
              type: "unavailable",
              cell_id: cell.id,
              reason: acquired.reason,
            },
        };
      }
      leases.push(acquired.lease);
      this.#observer?.event("world.residency.lease_acquired", {
        cell_id: cell.id,
        asset_id: acquired.lease.id,
        revision: acquired.lease.revision,
      });
    }
    try {
      const dependencies = new Map<AssetId, AssetLease>();
      for (let index = 1; index < leases.length; index += 1) {
        dependencies.set(leases[index].id, leases[index]);
      }
      const scene = await this.#decoder.decode(cell, leases[0], dependencies);
      return {
        type: "prepared",
        demand,
        value: { demand, cell, leases, scene },
      };
    } catch (error) {
      release_leases(leases);
      const reason = `cell ${JSON.stringify(cell.id)} decode failed: ${
        error_reason(error)
      }`;
      this.#observer?.diagnostic(
        "error",
        "world.residency.decode",
        reason,
        { cell_id: cell.id },
      );
      return {
        type: "failed",
        demand,
        state: {
          type: "unavailable",
          cell_id: cell.id,
          reason,
        },
      };
    }
  }

  #result(
    generation: number,
    cells: readonly CellResidencyState[],
    excluded: readonly CellId[],
  ): ResidencyResult {
    const resident_cells = this.resident();
    return Object.freeze({
      generation,
      cells: Object.freeze([...cells]),
      resident_cells,
      estimated_bytes: resident_cells.reduce(
        (total, cell) => total + cell.estimated_bytes,
        0,
      ),
      budget_excluded: Object.freeze([...excluded]),
    });
  }
}

export interface SpatialDemandOptions {
  readonly focus: GlobalPosition;
  readonly visible_distance: number;
  readonly prefetch_distance: number;
  readonly lod_distances?: readonly number[];
}

export function create_spatial_demand(
  partition: WorldPartition,
  options: SpatialDemandOptions,
): readonly ResidencyDemand[] {
  if (
    !Number.isFinite(options.visible_distance) ||
    options.visible_distance < 0 ||
    !Number.isFinite(options.prefetch_distance) ||
    options.prefetch_distance < options.visible_distance
  ) {
    throw new Error(
      `world demand distances visible=${options.visible_distance} prefetch=${options.prefetch_distance} must be finite with 0 <= visible <= prefetch`,
    );
  }
  const lod_distances = options.lod_distances ?? [];
  for (let index = 0; index < lod_distances.length; index += 1) {
    if (
      !Number.isFinite(lod_distances[index]) || lod_distances[index] < 0 ||
      (index > 0 && lod_distances[index] < lod_distances[index - 1])
    ) {
      throw new Error(
        `world LOD distances must be finite, nonnegative, and ordered`,
      );
    }
  }
  const located = new Set(partition.locate(options.focus).map(({ id }) => id));
  for (const id of [...located]) {
    for (const connected of partition.connected(id)) located.add(connected);
  }
  const candidates = partition.cells().map((cell) => ({
    cell,
    distance_squared: partition.distance_squared(cell, options.focus),
  })).filter(({ distance_squared }) =>
    distance_squared <= options.prefetch_distance ** 2
  );
  const by_coordinate = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const coordinate = candidate.cell.coordinate;
    const key = coordinate === undefined
      ? candidate.cell.id
      : `${coordinate.x}:${coordinate.z}`;
    const group = by_coordinate.get(key) ?? [];
    group.push(candidate);
    by_coordinate.set(key, group);
  }
  const demands: ResidencyDemand[] = [];
  for (const group of by_coordinate.values()) {
    const distance = Math.sqrt(group[0].distance_squared);
    const target_lod = lod_distances.filter((threshold) =>
      distance >= threshold
    ).length;
    const chosen = group.sort((left, right) => {
      const left_lod = left.cell.coordinate?.lod ?? 0;
      const right_lod = right.cell.coordinate?.lod ?? 0;
      return Math.abs(left_lod - target_lod) -
          Math.abs(right_lod - target_lod) ||
        left_lod - right_lod || left.cell.id.localeCompare(right.cell.id);
    })[0];
    demands.push({
      cell_id: chosen.cell.id,
      priority: located.has(chosen.cell.id)
        ? "blocking"
        : chosen.distance_squared <= options.visible_distance ** 2
        ? "visible"
        : "background",
      distance_squared: chosen.distance_squared,
    });
  }
  return Object.freeze(demands.sort(compare_demand));
}

function select_demands(
  partition: WorldPartition,
  demands: readonly ResidencyDemand[],
  budget: ResidencyBudget,
): {
  readonly demands: readonly ResidencyDemand[];
  readonly excluded: readonly CellId[];
} {
  const best = new Map<CellId, ResidencyDemand>();
  for (const demand of demands) {
    if (
      !Number.isFinite(demand.distance_squared) || demand.distance_squared < 0
    ) {
      throw new Error(
        `world demand ${JSON.stringify(demand.cell_id)} distance ${
          JSON.stringify(demand.distance_squared)
        } must be finite and nonnegative`,
      );
    }
    if (!Object.hasOwn(priority_rank, demand.priority)) {
      throw new Error(
        `world demand ${JSON.stringify(demand.cell_id)} priority ${
          JSON.stringify(demand.priority)
        } is invalid`,
      );
    }
    if (demand.refresh !== undefined && typeof demand.refresh !== "boolean") {
      throw new Error(
        `world demand ${JSON.stringify(demand.cell_id)} refresh ${
          JSON.stringify(demand.refresh)
        } must be boolean`,
      );
    }
    const id = cell_id(demand.cell_id);
    if (partition.cell(id) === undefined) {
      throw new Error(
        `world demand references missing cell ${
          JSON.stringify(demand.cell_id)
        }`,
      );
    }
    const parsed = Object.freeze({ ...demand, cell_id: id });
    const current = best.get(id);
    if (current === undefined || compare_demand(parsed, current) < 0) {
      best.set(id, parsed);
    }
  }
  const selected: ResidencyDemand[] = [];
  const excluded: CellId[] = [];
  let estimated_bytes = 0;
  for (const demand of [...best.values()].sort(compare_demand)) {
    const cell = partition.cell(demand.cell_id)!;
    if (
      selected.length === budget.maximum_cells ||
      estimated_bytes + cell.estimated_bytes > budget.maximum_estimated_bytes
    ) {
      excluded.push(cell.id);
      continue;
    }
    selected.push(demand);
    estimated_bytes += cell.estimated_bytes;
  }
  return { demands: selected, excluded };
}

function compare_demand(left: ResidencyDemand, right: ResidencyDemand): number {
  return priority_rank[left.priority] - priority_rank[right.priority] ||
    left.distance_squared - right.distance_squared ||
    Number(right.refresh === true) - Number(left.refresh === true) ||
    left.cell_id.localeCompare(right.cell_id);
}

function parse_budget(budget: ResidencyBudget): ResidencyBudget {
  if (
    !Number.isSafeInteger(budget.maximum_cells) || budget.maximum_cells < 0 ||
    !Number.isSafeInteger(budget.maximum_estimated_bytes) ||
    budget.maximum_estimated_bytes < 0
  ) {
    throw new Error(
      `world residency budget cells=${budget.maximum_cells} bytes=${budget.maximum_estimated_bytes} must be nonnegative safe integers`,
    );
  }
  return { ...budget };
}

function resident_cell(record: ResidentRecord): ResidentCell {
  return Object.freeze({
    cell_id: record.cell.id,
    scene_revision: record.leases[0].revision,
    scene: record.scene,
    estimated_bytes: record.cell.estimated_bytes,
  });
}

function release_leases(leases: readonly AssetLease[]): void {
  const failures: unknown[] = [];
  for (let index = leases.length - 1; index >= 0; index -= 1) {
    try {
      leases[index].release();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} world asset leases failed to release`,
    );
  }
}

function error_reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
