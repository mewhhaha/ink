import type {
  ObservationClock,
  ObservationValue,
} from "@ink/observability/model.ts";
import { Observer } from "@ink/observability/observer.ts";
import type { ObservationSink } from "@ink/observability/sink.ts";
import { create_entity, type Entity, type EntityLookup } from "./entity.ts";
import {
  type AnyComponent,
  type AnyResource,
  clone_schema_value,
  type Component,
  parse_schema_set,
  type Resource,
  schema_digest,
  schema_entry_digest,
  type SnapshotValue,
} from "./schema.ts";
import { SparseSet } from "./storage.ts";

export type { Entity, EntityDomain, EntityLookup } from "./entity.ts";

export type WorldDomain =
  | { readonly type: "dynamic"; readonly capacity: number }
  | { readonly type: "fixed"; readonly count: number };

export interface WorldObservations {
  readonly sink: ObservationSink;
  readonly clock: ObservationClock;
  readonly instance?: string;
  readonly correlation_id?: string;
}

export interface WorldOptions {
  readonly domain: WorldDomain;
  readonly components?: readonly AnyComponent[];
  readonly resources?: readonly AnyResource[];
  readonly observations?: WorldObservations;
}

export type SpawnResult =
  | { readonly type: "spawned"; readonly entity: Entity }
  | { readonly type: "capacity_exhausted"; readonly capacity: number }
  | { readonly type: "fixed_domain" }
  | { readonly type: "structural_changes_locked" };

export type StructuralResult =
  | { readonly type: "changed"; readonly tick: number }
  | { readonly type: "missing_component" }
  | { readonly type: "fixed_domain" }
  | { readonly type: "structural_changes_locked" }
  | Exclude<EntityLookup, { readonly type: "alive" }>;

export type ComponentLookup<value> =
  | {
    readonly type: "present";
    readonly value: value;
    readonly changed_at: number;
  }
  | { readonly type: "missing" }
  | Exclude<EntityLookup, { readonly type: "alive" }>;

export type ResourceLookup<value> =
  | {
    readonly type: "present";
    readonly value: value;
    readonly changed_at: number;
  }
  | { readonly type: "missing" };

export interface ComponentAccess<value = unknown> {
  readonly type: "component_access";
  readonly mode: "read" | "write";
  readonly component: Component<value>;
}

export type AccessValue<access> = access extends ComponentAccess<infer value>
  ? value
  : never;

export interface QueryDescription<
  accesses extends readonly ComponentAccess<unknown>[] =
    readonly ComponentAccess<unknown>[],
> {
  readonly type: "query";
  readonly accesses: accesses;
}

export interface QueryRow<
  accesses extends readonly ComponentAccess<unknown>[],
> {
  readonly entity: Entity;
  readonly values: {
    readonly [key in keyof accesses]: AccessValue<accesses[key]>;
  };
}

export interface QueryCursor<
  accesses extends readonly ComponentAccess<unknown>[],
> {
  readonly span: number;
  next(): QueryRow<accesses> | undefined;
}

export type ComponentChange =
  | {
    readonly type: "inserted" | "updated";
    readonly component: string;
    readonly entity: Entity;
    readonly tick: number;
    readonly value: unknown;
  }
  | {
    readonly type: "removed";
    readonly component: string;
    readonly entity: Entity;
    readonly tick: number;
  };

export interface SnapshotSchemaEntry {
  readonly id: string;
  readonly version: number;
}

export interface SnapshotEntityState {
  readonly generation: number;
  readonly alive: boolean;
}

export interface SnapshotComponentValue {
  readonly entity: number;
  readonly generation: number;
  readonly changed_at: number;
  readonly value: SnapshotValue;
}

export interface SnapshotComponent {
  readonly id: string;
  readonly values: readonly SnapshotComponentValue[];
}

export interface SnapshotResource {
  readonly id: string;
  readonly changed_at: number;
  readonly value: SnapshotValue;
}

export interface SnapshotChange {
  readonly type: "inserted" | "updated" | "removed";
  readonly component: string;
  readonly entity: number;
  readonly generation: number;
  readonly tick: number;
  readonly value?: SnapshotValue;
}

export interface EcsSnapshot {
  readonly format: "ink.ecs";
  readonly version: 1;
  readonly schema: {
    readonly digest: string;
    readonly components: readonly SnapshotSchemaEntry[];
    readonly resources: readonly SnapshotSchemaEntry[];
  };
  readonly domain: WorldDomain;
  readonly tick: number;
  readonly entities: readonly SnapshotEntityState[];
  readonly next_index: number;
  readonly free_indices: readonly number[];
  readonly components: readonly SnapshotComponent[];
  readonly resources: readonly SnapshotResource[];
  readonly changes: readonly SnapshotChange[];
}

export type RestoreResult =
  | { readonly type: "restored"; readonly tick: number }
  | {
    readonly type: "incompatible";
    readonly reason: string;
    readonly evidence: Readonly<Record<string, SnapshotValue>>;
  };

interface ComponentState<value> {
  readonly definition: Component<value>;
  readonly storage: SparseSet<value>;
}

interface ResourceState<value> {
  readonly definition: Resource<value>;
  value:
    | { readonly type: "missing" }
    | { readonly type: "present"; readonly value: value };
  changed_at: number;
}

interface RecordedChange {
  readonly type: "inserted" | "updated" | "removed";
  readonly component: string;
  readonly entity: Entity;
  readonly tick: number;
  readonly value?: unknown;
}

export function read<value>(
  component: Component<value>,
): ComponentAccess<value> {
  return Object.freeze({ type: "component_access", mode: "read", component });
}

export function write<value>(
  component: Component<value>,
): ComponentAccess<value> {
  return Object.freeze({ type: "component_access", mode: "write", component });
}

export function query<
  const accesses extends readonly ComponentAccess<unknown>[],
>(...accesses: accesses): QueryDescription<accesses> {
  if (accesses.length === 0) {
    throw new Error("ECS query requires at least one component access");
  }
  const identities = new Set<string>();
  for (const access of accesses) {
    if (identities.has(access.component.id)) {
      throw new Error(
        `ECS query contains component ${
          JSON.stringify(access.component.id)
        } more than once`,
      );
    }
    identities.add(access.component.id);
  }
  return Object.freeze({
    type: "query",
    accesses: Object.freeze([...accesses]),
  }) as QueryDescription<accesses>;
}

export class World {
  readonly #domain: WorldDomain;
  readonly #capacity: number;
  readonly #component_states = new Map<string, ComponentState<unknown>>();
  readonly #resource_states = new Map<string, ResourceState<unknown>>();
  readonly #generations: number[];
  readonly #alive: boolean[];
  readonly #free_indices: number[] = [];
  readonly #observer: Observer | undefined;
  readonly #clock: ObservationClock | undefined;
  readonly #schema_digest: string;
  readonly #changes: RecordedChange[] = [];
  #next_index = 0;
  #tick = 0;
  #structural_changes_locked = false;

  constructor(options: WorldOptions) {
    const components = options.components ?? [];
    const resources = options.resources ?? [];
    parse_schema_set(components, resources);
    this.#domain = parse_domain(options.domain);
    this.#capacity = this.#domain.type === "dynamic"
      ? this.#domain.capacity
      : this.#domain.count;
    this.#generations = Array.from({ length: this.#capacity }, () => 0);
    this.#alive = Array.from(
      { length: this.#capacity },
      () => this.#domain.type === "fixed",
    );
    this.#next_index = this.#domain.type === "fixed" ? this.#capacity : 0;
    for (const component of components) {
      this.#component_states.set(component.id, {
        definition: component,
        storage: new SparseSet(this.#capacity),
      });
    }
    for (const resource of resources) {
      this.#resource_states.set(resource.id, {
        definition: resource,
        value: { type: "missing" },
        changed_at: 0,
      });
    }
    this.#schema_digest = schema_digest(components, resources);
    if (options.observations) {
      this.#clock = options.observations.clock;
      this.#observer = new Observer({
        source: {
          subsystem: "ecs",
          ...(options.observations.instance === undefined
            ? {}
            : { instance: options.observations.instance }),
        },
        sink: options.observations.sink,
        clock: options.observations.clock,
        ...(options.observations.correlation_id === undefined
          ? {}
          : { correlation_id: options.observations.correlation_id }),
      });
    }
    this.observe("world.created", {
      capacity: this.#capacity,
      component_count: components.length,
      resource_count: resources.length,
      domain: this.#domain.type,
    });
  }

  get capacity(): number {
    return this.#capacity;
  }

  get tick(): number {
    return this.#tick;
  }

  get digest(): string {
    return this.#schema_digest;
  }

  entity_at(index: number): EntityLookup {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.#capacity) {
      return {
        type: "outside_domain",
        entity: create_entity(index, 0, this.#domain.type),
      };
    }
    const entity = create_entity(
      index,
      this.#generations[index],
      this.#domain.type,
    );
    if (!this.#alive[index]) {
      return {
        type: "stale",
        entity,
        actual_generation: this.#generations[index],
        alive: false,
      };
    }
    return { type: "alive", entity };
  }

  lookup(entity: Entity): EntityLookup {
    if (
      entity.domain !== this.#domain.type || entity.index < 0 ||
      entity.index >= this.#capacity
    ) {
      return { type: "outside_domain", entity };
    }
    const actual_generation = this.#generations[entity.index];
    if (
      !this.#alive[entity.index] || entity.generation !== actual_generation
    ) {
      return {
        type: "stale",
        entity,
        actual_generation,
        alive: this.#alive[entity.index],
      };
    }
    return { type: "alive", entity };
  }

  spawn(): SpawnResult {
    if (this.#domain.type === "fixed") return { type: "fixed_domain" };
    if (this.#structural_changes_locked) {
      return { type: "structural_changes_locked" };
    }
    let index: number;
    if (this.#free_indices.length > 0) {
      index = this.#free_indices.pop()!;
    } else {
      if (this.#next_index === this.#capacity) {
        return { type: "capacity_exhausted", capacity: this.#capacity };
      }
      index = this.#next_index;
      this.#next_index += 1;
    }
    this.#alive[index] = true;
    const entity = create_entity(index, this.#generations[index], "dynamic");
    const tick = this.next_tick();
    this.observe("entity.spawned", {
      index,
      generation: entity.generation,
      tick,
    });
    return { type: "spawned", entity };
  }

  despawn(entity: Entity): StructuralResult {
    if (this.#structural_changes_locked) {
      return { type: "structural_changes_locked" };
    }
    if (this.#domain.type === "fixed") return { type: "fixed_domain" };
    const lookup = this.lookup(entity);
    if (lookup.type !== "alive") return lookup;
    const tick = this.next_tick();
    for (const state of this.#component_states.values()) {
      if (state.storage.has(entity.index)) {
        state.storage.remove(entity.index);
        this.#changes.push({
          type: "removed",
          component: state.definition.id,
          entity,
          tick,
        });
      }
    }
    this.#alive[entity.index] = false;
    this.#generations[entity.index] += 1;
    this.#free_indices.push(entity.index);
    this.observe("entity.despawned", {
      index: entity.index,
      generation: entity.generation,
      tick,
    });
    return { type: "changed", tick };
  }

  insert<value>(
    entity: Entity,
    component: Component<value>,
    value: value,
  ): StructuralResult {
    if (this.#structural_changes_locked) {
      return { type: "structural_changes_locked" };
    }
    const lookup = this.lookup(entity);
    if (lookup.type !== "alive") return lookup;
    const state = this.component_state(component);
    const tick = this.next_tick();
    const stored = clone_schema_value(component, value);
    const mutation = state.storage.set(entity.index, stored, tick);
    this.#changes.push({
      type: mutation,
      component: component.id,
      entity,
      tick,
      value: stored,
    });
    this.observe(`component.${mutation}`, {
      component: component.id,
      entity: entity.index,
      generation: entity.generation,
      tick,
    });
    return { type: "changed", tick };
  }

  set<value>(
    entity: Entity,
    component: Component<value>,
    value: value,
  ): StructuralResult {
    const lookup = this.lookup(entity);
    if (lookup.type !== "alive") return lookup;
    const state = this.component_state(component);
    if (!state.storage.has(entity.index)) return { type: "missing_component" };
    const tick = this.next_tick();
    const stored = clone_schema_value(component, value);
    state.storage.set(entity.index, stored, tick);
    this.#changes.push({
      type: "updated",
      component: component.id,
      entity,
      tick,
      value: stored,
    });
    this.observe("component.updated", {
      component: component.id,
      entity: entity.index,
      generation: entity.generation,
      tick,
    });
    return { type: "changed", tick };
  }

  remove<value>(
    entity: Entity,
    component: Component<value>,
  ): StructuralResult {
    if (this.#structural_changes_locked) {
      return { type: "structural_changes_locked" };
    }
    const lookup = this.lookup(entity);
    if (lookup.type !== "alive") return lookup;
    const state = this.component_state(component);
    if (!state.storage.has(entity.index)) return { type: "missing_component" };
    state.storage.remove(entity.index);
    const tick = this.next_tick();
    this.#changes.push({
      type: "removed",
      component: component.id,
      entity,
      tick,
    });
    this.observe("component.removed", {
      component: component.id,
      entity: entity.index,
      generation: entity.generation,
      tick,
    });
    return { type: "changed", tick };
  }

  get<value>(
    entity: Entity,
    component: Component<value>,
  ): ComponentLookup<value> {
    const lookup = this.lookup(entity);
    if (lookup.type !== "alive") return lookup;
    const state = this.component_state(component);
    if (!state.storage.has(entity.index)) return { type: "missing" };
    const value = state.storage.get(entity.index)!;
    return {
      type: "present",
      value: clone_schema_value(component, value),
      changed_at: state.storage.changed_at(entity.index)!,
    };
  }

  set_resource<value>(resource: Resource<value>, value: value): number {
    const state = this.resource_state(resource);
    const tick = this.next_tick();
    state.value = {
      type: "present",
      value: clone_schema_value(resource, value),
    };
    state.changed_at = tick;
    this.observe("resource.updated", { resource: resource.id, tick });
    return tick;
  }

  get_resource<value>(resource: Resource<value>): ResourceLookup<value> {
    const state = this.resource_state(resource);
    if (state.value.type === "missing") return { type: "missing" };
    return {
      type: "present",
      value: clone_schema_value(resource, state.value.value),
      changed_at: state.changed_at,
    };
  }

  rows<const accesses extends readonly ComponentAccess<unknown>[]>(
    description: QueryDescription<accesses>,
  ): readonly QueryRow<accesses>[] {
    const cursor = this.cursor(description);
    const rows: QueryRow<accesses>[] = [];
    for (let row = cursor.next(); row !== undefined; row = cursor.next()) {
      rows.push(row);
    }
    return rows;
  }

  cursor<const accesses extends readonly ComponentAccess<unknown>[]>(
    description: QueryDescription<accesses>,
  ): QueryCursor<accesses> {
    const states = description.accesses.map((access) =>
      this.component_state(access.component)
    );
    let driving_index = 0;
    for (let index = 1; index < states.length; index += 1) {
      if (states[index].storage.size < states[driving_index].storage.size) {
        driving_index = index;
      }
    }
    const candidates = states[driving_index].storage.entity_indices();
    this.observe("query.created", {
      access_count: description.accesses.length,
      span: candidates.length,
    });
    let position = 0;
    return {
      span: candidates.length,
      next: () => {
        while (position < candidates.length) {
          const entity_index = candidates[position];
          position += 1;
          if (!states.every((state) => state.storage.has(entity_index))) {
            continue;
          }
          const entity = create_entity(
            entity_index,
            this.#generations[entity_index],
            this.#domain.type,
          );
          const values = states.map((state) =>
            clone_schema_value(
              state.definition,
              state.storage.get(entity_index)!,
            )
          );
          return { entity, values } as QueryRow<accesses>;
        }
        return undefined;
      },
    };
  }

  changes_since(tick: number): readonly ComponentChange[] {
    if (!Number.isSafeInteger(tick) || tick < 0 || tick > this.#tick) {
      throw new Error(
        `ECS change tick ${
          JSON.stringify(tick)
        } must be between 0 and ${this.#tick}`,
      );
    }
    const changes = this.#changes.filter((change) => change.tick > tick).map(
      (change): ComponentChange => {
        if (change.type === "removed") {
          return {
            type: "removed",
            component: change.component,
            entity: change.entity,
            tick: change.tick,
          };
        }
        const definition =
          this.#component_states.get(change.component)!.definition;
        return {
          ...change,
          value: clone_schema_value(definition, change.value),
        };
      },
    );
    this.observe("changes.extracted", {
      since_tick: tick,
      count: changes.length,
    });
    return changes;
  }

  snapshot(): EcsSnapshot {
    const started_at = this.#clock?.now_seconds();
    const components = [...this.#component_states.values()]
      .sort((left, right) =>
        left.definition.id.localeCompare(right.definition.id)
      )
      .map((state): SnapshotComponent => ({
        id: state.definition.id,
        values: state.storage.entity_indices().slice().sort((a, b) => a - b)
          .map(
            (entity): SnapshotComponentValue => ({
              entity,
              generation: this.#generations[entity],
              changed_at: state.storage.changed_at(entity)!,
              value: state.definition.codec.encode(state.storage.get(entity)!),
            }),
          ),
      }));
    const resources = [...this.#resource_states.values()]
      .sort((left, right) =>
        left.definition.id.localeCompare(right.definition.id)
      )
      .flatMap((state): readonly SnapshotResource[] =>
        state.value.type === "missing" ? [] : [{
          id: state.definition.id,
          changed_at: state.changed_at,
          value: state.definition.codec.encode(state.value.value),
        }]
      );
    const snapshot: EcsSnapshot = {
      format: "ink.ecs",
      version: 1,
      schema: {
        digest: this.#schema_digest,
        components: [...this.#component_states.values()]
          .map((state) => ({
            id: state.definition.id,
            version: state.definition.version,
          })).sort((left, right) => left.id.localeCompare(right.id)),
        resources: [...this.#resource_states.values()]
          .map((state) => ({
            id: state.definition.id,
            version: state.definition.version,
          })).sort((left, right) => left.id.localeCompare(right.id)),
      },
      domain: this.#domain,
      tick: this.#tick,
      entities: this.#generations.map((generation, index) => ({
        generation,
        alive: this.#alive[index],
      })),
      next_index: this.#next_index,
      free_indices: this.#free_indices.slice(),
      components,
      resources,
      changes: this.#changes.map((change): SnapshotChange => ({
        type: change.type,
        component: change.component,
        entity: change.entity.index,
        generation: change.entity.generation,
        tick: change.tick,
        ...(change.value === undefined ? {} : {
          value: this.#component_states.get(change.component)!.definition.codec
            .encode(
              change.value,
            ),
        }),
      })),
    };
    this.observe("snapshot.created", {
      component_count: components.length,
      entity_count: this.#alive.filter(Boolean).length,
      ...(started_at === undefined || this.#clock === undefined
        ? {}
        : { duration_seconds: this.#clock.now_seconds() - started_at }),
    });
    return snapshot;
  }

  restore(snapshot: EcsSnapshot): RestoreResult {
    const incompatibility = this.check_snapshot_compatibility(snapshot);
    if (incompatibility) return incompatibility;
    const decoded_components = new Map<string, {
      readonly entity: number;
      readonly changed_at: number;
      readonly value: unknown;
    }[]>();
    for (const component of snapshot.components) {
      const state = this.#component_states.get(component.id)!;
      const values = [];
      for (const encoded of component.values) {
        if (
          encoded.entity < 0 || encoded.entity >= this.#capacity ||
          !snapshot.entities[encoded.entity]?.alive ||
          snapshot.entities[encoded.entity].generation !== encoded.generation
        ) {
          return incompatible("component entity is not alive in snapshot", {
            component: component.id,
            entity: encoded.entity,
            generation: encoded.generation,
          });
        }
        const decoded = state.definition.codec.decode(encoded.value);
        if (decoded.type === "invalid") {
          return incompatible("component value failed to decode", {
            component: component.id,
            entity: encoded.entity,
            reason: decoded.reason,
          });
        }
        values.push({
          entity: encoded.entity,
          changed_at: encoded.changed_at,
          value: decoded.value,
        });
      }
      decoded_components.set(component.id, values);
    }
    const decoded_resources = new Map<
      string,
      { value: unknown; changed_at: number }
    >();
    for (const encoded of snapshot.resources) {
      const state = this.#resource_states.get(encoded.id)!;
      const decoded = state.definition.codec.decode(encoded.value);
      if (decoded.type === "invalid") {
        return incompatible("resource value failed to decode", {
          resource: encoded.id,
          reason: decoded.reason,
        });
      }
      decoded_resources.set(encoded.id, {
        value: decoded.value,
        changed_at: encoded.changed_at,
      });
    }
    const decoded_changes: RecordedChange[] = [];
    for (const change of snapshot.changes) {
      const state = this.#component_states.get(change.component)!;
      let value: unknown;
      if (change.value !== undefined) {
        const decoded = state.definition.codec.decode(change.value);
        if (decoded.type === "invalid") {
          return incompatible("change value failed to decode", {
            component: change.component,
            tick: change.tick,
            reason: decoded.reason,
          });
        }
        value = decoded.value;
      }
      decoded_changes.push({
        type: change.type,
        component: change.component,
        entity: create_entity(
          change.entity,
          change.generation,
          this.#domain.type,
        ),
        tick: change.tick,
        ...(value === undefined ? {} : { value }),
      });
    }
    for (let index = 0; index < this.#capacity; index += 1) {
      this.#generations[index] = snapshot.entities[index].generation;
      this.#alive[index] = snapshot.entities[index].alive;
    }
    this.#next_index = snapshot.next_index;
    this.#free_indices.length = 0;
    this.#free_indices.push(...snapshot.free_indices);
    for (const state of this.#component_states.values()) state.storage.clear();
    for (const [id, values] of decoded_components) {
      const state = this.#component_states.get(id)!;
      for (const value of values) {
        state.storage.set(value.entity, value.value, value.changed_at);
      }
    }
    for (const state of this.#resource_states.values()) {
      const decoded = decoded_resources.get(state.definition.id);
      state.value = decoded === undefined
        ? { type: "missing" }
        : { type: "present", value: decoded.value };
      state.changed_at = decoded?.changed_at ?? 0;
    }
    this.#changes.length = 0;
    this.#changes.push(...decoded_changes);
    this.#tick = snapshot.tick;
    this.observe("snapshot.restored", {
      tick: snapshot.tick,
      snapshot_digest: snapshot.schema.digest,
      world_digest: this.#schema_digest,
    });
    return { type: "restored", tick: snapshot.tick };
  }

  begin_system_execution(): void {
    if (this.#structural_changes_locked) {
      throw new Error(
        "ECS system execution began while structural changes were already locked",
      );
    }
    this.#structural_changes_locked = true;
  }

  end_system_execution(): void {
    if (!this.#structural_changes_locked) {
      throw new Error("ECS system execution ended without a matching begin");
    }
    this.#structural_changes_locked = false;
  }

  observe(
    name: string,
    evidence: Readonly<Record<string, ObservationValue>>,
  ): void {
    this.#observer?.event(name, evidence);
  }

  private check_snapshot_compatibility(
    snapshot: EcsSnapshot,
  ): RestoreResult | undefined {
    if (snapshot.format !== "ink.ecs" || snapshot.version !== 1) {
      return incompatible("snapshot format or version is unsupported", {
        format: snapshot.format,
        version: snapshot.version,
      });
    }
    if (
      snapshot.domain.type !== this.#domain.type ||
      domain_capacity(snapshot.domain) !== this.#capacity
    ) {
      return incompatible("snapshot entity domain does not match world", {
        snapshot_domain: snapshot.domain.type,
        snapshot_capacity: domain_capacity(snapshot.domain),
        world_domain: this.#domain.type,
        world_capacity: this.#capacity,
      });
    }
    if (snapshot.entities.length !== this.#capacity) {
      return incompatible(
        "snapshot entity state count does not match world capacity",
        {
          entity_count: snapshot.entities.length,
          world_capacity: this.#capacity,
        },
      );
    }
    const calculated_digest = schema_entry_digest(
      snapshot.schema.components,
      snapshot.schema.resources,
    );
    if (snapshot.schema.digest !== calculated_digest) {
      return incompatible("snapshot schema digest does not match its entries", {
        snapshot_digest: snapshot.schema.digest,
        calculated_digest,
      });
    }
    const component_schema_ids = new Set<string>();
    for (const entry of snapshot.schema.components) {
      if (component_schema_ids.has(entry.id)) {
        return incompatible("snapshot component schema is duplicated", {
          component: entry.id,
        });
      }
      component_schema_ids.add(entry.id);
      const current = this.#component_states.get(entry.id)?.definition;
      if (!current || current.version !== entry.version) {
        return incompatible("snapshot component schema is unavailable", {
          component: entry.id,
          snapshot_version: entry.version,
          world_version: current?.version ?? null,
        });
      }
    }
    const resource_schema_ids = new Set<string>();
    for (const entry of snapshot.schema.resources) {
      if (resource_schema_ids.has(entry.id)) {
        return incompatible("snapshot resource schema is duplicated", {
          resource: entry.id,
        });
      }
      resource_schema_ids.add(entry.id);
      const current = this.#resource_states.get(entry.id)?.definition;
      if (!current || current.version !== entry.version) {
        return incompatible("snapshot resource schema is unavailable", {
          resource: entry.id,
          snapshot_version: entry.version,
          world_version: current?.version ?? null,
        });
      }
    }
    for (const [index, entity] of snapshot.entities.entries()) {
      if (!Number.isSafeInteger(entity.generation) || entity.generation < 0) {
        return incompatible("snapshot entity generation is invalid", {
          entity: index,
          generation: entity.generation,
        });
      }
      if (typeof entity.alive !== "boolean") {
        return incompatible("snapshot entity alive flag is invalid", {
          entity: index,
        });
      }
    }
    if (
      !Number.isSafeInteger(snapshot.next_index) || snapshot.next_index < 0 ||
      snapshot.next_index > this.#capacity
    ) {
      return incompatible("snapshot allocator next index is invalid", {
        next_index: snapshot.next_index,
        world_capacity: this.#capacity,
      });
    }
    const free_indices = new Set<number>();
    for (const free_index of snapshot.free_indices) {
      if (
        !Number.isSafeInteger(free_index) || free_index < 0 ||
        free_index >= snapshot.next_index || free_indices.has(free_index) ||
        snapshot.entities[free_index]?.alive
      ) {
        return incompatible("snapshot allocator free index is invalid", {
          free_index,
          next_index: snapshot.next_index,
        });
      }
      free_indices.add(free_index);
    }
    if (this.#domain.type === "fixed") {
      if (
        snapshot.next_index !== this.#capacity ||
        snapshot.free_indices.length > 0 ||
        snapshot.entities.some((entity) =>
          !entity.alive || entity.generation !== 0
        )
      ) {
        return incompatible(
          "snapshot fixed domain allocator state is invalid",
          {
            next_index: snapshot.next_index,
            free_count: snapshot.free_indices.length,
          },
        );
      }
    } else {
      for (const [index, entity] of snapshot.entities.entries()) {
        if (index < snapshot.next_index) {
          if (!entity.alive && !free_indices.has(index)) {
            return incompatible(
              "snapshot allocated entity is neither alive nor free",
              {
                entity: index,
              },
            );
          }
        } else if (
          entity.alive || free_indices.has(index) || entity.generation !== 0
        ) {
          return incompatible(
            "snapshot unallocated entity has allocator state",
            {
              entity: index,
              generation: entity.generation,
              alive: entity.alive,
            },
          );
        }
      }
    }
    const component_value_ids = new Set<string>();
    for (const component of snapshot.components) {
      if (
        !this.#component_states.has(component.id) ||
        !component_schema_ids.has(component.id)
      ) {
        return incompatible("snapshot component values have no world schema", {
          component: component.id,
        });
      }
      if (component_value_ids.has(component.id)) {
        return incompatible("snapshot component values are duplicated", {
          component: component.id,
        });
      }
      component_value_ids.add(component.id);
      const entities = new Set<number>();
      for (const value of component.values) {
        if (entities.has(value.entity)) {
          return incompatible("snapshot component entity is duplicated", {
            component: component.id,
            entity: value.entity,
          });
        }
        entities.add(value.entity);
        if (!valid_snapshot_tick(value.changed_at, snapshot.tick)) {
          return incompatible("snapshot component change tick is invalid", {
            component: component.id,
            entity: value.entity,
            changed_at: value.changed_at,
            snapshot_tick: snapshot.tick,
          });
        }
      }
    }
    const resource_value_ids = new Set<string>();
    for (const resource of snapshot.resources) {
      if (
        !this.#resource_states.has(resource.id) ||
        !resource_schema_ids.has(resource.id)
      ) {
        return incompatible("snapshot resource value has no world schema", {
          resource: resource.id,
        });
      }
      if (resource_value_ids.has(resource.id)) {
        return incompatible("snapshot resource value is duplicated", {
          resource: resource.id,
        });
      }
      resource_value_ids.add(resource.id);
      if (!valid_snapshot_tick(resource.changed_at, snapshot.tick)) {
        return incompatible("snapshot resource change tick is invalid", {
          resource: resource.id,
          changed_at: resource.changed_at,
          snapshot_tick: snapshot.tick,
        });
      }
    }
    let previous_change_tick = 0;
    for (const change of snapshot.changes) {
      if (
        !this.#component_states.has(change.component) ||
        !component_schema_ids.has(change.component)
      ) {
        return incompatible("snapshot change has no world component schema", {
          component: change.component,
          tick: change.tick,
        });
      }
      if (
        !valid_snapshot_tick(change.tick, snapshot.tick) ||
        !Number.isSafeInteger(change.entity) || change.entity < 0 ||
        change.entity >= this.#capacity ||
        !Number.isSafeInteger(change.generation) || change.generation < 0 ||
        change.generation > snapshot.entities[change.entity].generation ||
        change.tick < previous_change_tick ||
        (change.type === "removed" && change.value !== undefined) ||
        (change.type !== "removed" && change.value === undefined)
      ) {
        return incompatible("snapshot change record is invalid", {
          component: change.component,
          entity: change.entity,
          generation: change.generation,
          tick: change.tick,
          change_type: change.type,
        });
      }
      previous_change_tick = change.tick;
    }
    if (!Number.isSafeInteger(snapshot.tick) || snapshot.tick < 0) {
      return incompatible("snapshot tick is invalid", { tick: snapshot.tick });
    }
    return undefined;
  }

  private component_state<value>(
    component: Component<value>,
  ): ComponentState<value> {
    const state = this.#component_states.get(component.id);
    if (!state || state.definition !== component) {
      throw new Error(
        `ECS world does not contain component ${
          JSON.stringify(component.id)
        } version ${component.version}`,
      );
    }
    return state as ComponentState<value>;
  }

  private resource_state<value>(
    resource: Resource<value>,
  ): ResourceState<value> {
    const state = this.#resource_states.get(resource.id);
    if (!state || state.definition !== resource) {
      throw new Error(
        `ECS world does not contain resource ${
          JSON.stringify(resource.id)
        } version ${resource.version}`,
      );
    }
    return state as ResourceState<value>;
  }

  private next_tick(): number {
    if (this.#tick === Number.MAX_SAFE_INTEGER) {
      throw new Error("ECS change tick exhausted the safe integer range");
    }
    this.#tick += 1;
    return this.#tick;
  }
}

function parse_domain(domain: WorldDomain): WorldDomain {
  const capacity = domain_capacity(domain);
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new Error(
      `ECS ${domain.type} entity capacity ${
        JSON.stringify(capacity)
      } must be a positive safe integer`,
    );
  }
  return Object.freeze({ ...domain });
}

function domain_capacity(domain: WorldDomain): number {
  return domain.type === "dynamic" ? domain.capacity : domain.count;
}

function valid_snapshot_tick(value: number, snapshot_tick: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= snapshot_tick;
}

function incompatible(
  reason: string,
  evidence: Readonly<Record<string, SnapshotValue>>,
): RestoreResult {
  return { type: "incompatible", reason, evidence };
}
