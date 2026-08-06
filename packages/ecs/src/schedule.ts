import { clone_schema_value, type Component, type Resource } from "./schema.ts";
import type { Entity } from "./entity.ts";
import {
  type ComponentAccess,
  type ComponentLookup,
  type QueryDescription,
  type QueryRow,
  type ResourceLookup,
  type StructuralResult,
  type World,
} from "./world.ts";

export interface ResourceAccess<value = unknown> {
  readonly type: "resource_access";
  readonly mode: "read" | "write";
  readonly resource: Resource<value>;
}

export type SystemAccess = ComponentAccess<unknown> | ResourceAccess<unknown>;

export interface ComponentAssignment<value = unknown> {
  readonly component: Component<value>;
  readonly value: value;
}

type StructuralCommand =
  | {
    readonly type: "spawn";
    readonly components: readonly ComponentAssignment[];
  }
  | { readonly type: "despawn"; readonly entity: Entity }
  | {
    readonly type: "insert";
    readonly entity: Entity;
    readonly assignment: ComponentAssignment;
  }
  | {
    readonly type: "remove";
    readonly entity: Entity;
    readonly component: Component<unknown>;
  };

export interface StructuralCommands {
  spawn(components?: readonly ComponentAssignment[]): void;
  despawn(entity: Entity): void;
  insert<value>(
    entity: Entity,
    component: Component<value>,
    value: value,
  ): void;
  remove(entity: Entity, component: Component<unknown>): void;
}

export interface SystemContext {
  readonly commands: StructuralCommands;
  rows<const accesses extends readonly ComponentAccess<unknown>[]>(
    description: QueryDescription<accesses>,
  ): readonly QueryRow<accesses>[];
  get<value>(
    entity: Entity,
    component: Component<value>,
  ): ComponentLookup<value>;
  set<value>(
    entity: Entity,
    component: Component<value>,
    value: value,
  ): StructuralResult;
  get_resource<value>(resource: Resource<value>): ResourceLookup<value>;
  set_resource<value>(resource: Resource<value>, value: value): number;
}

export interface SystemDefinition {
  readonly id: string;
  readonly accesses: readonly SystemAccess[];
  readonly run: (context: SystemContext) => void;
}

export interface System {
  readonly id: string;
  readonly accesses: readonly SystemAccess[];
  readonly run: (context: SystemContext) => void;
}

export interface ScheduleStage {
  readonly systems: readonly System[];
}

export interface Schedule {
  readonly stages: readonly ScheduleStage[];
  run(world: World): ScheduleRunResult;
}

export type ScheduleRunResult =
  | {
    readonly type: "completed";
    readonly barriers: number;
    readonly spawned: readonly Entity[];
  }
  | {
    readonly type: "failed";
    readonly stage: number;
    readonly system?: string;
    readonly reason: string;
  };

export function read_resource<value>(
  resource: Resource<value>,
): ResourceAccess<value> {
  return Object.freeze({ type: "resource_access", mode: "read", resource });
}

export function write_resource<value>(
  resource: Resource<value>,
): ResourceAccess<value> {
  return Object.freeze({ type: "resource_access", mode: "write", resource });
}

export function component_value<value>(
  component: Component<value>,
  value: value,
): ComponentAssignment<value> {
  return Object.freeze({
    component,
    value: clone_schema_value(component, value),
  });
}

export function define_system(definition: SystemDefinition): System {
  const id = definition.id.trim();
  if (id.length === 0) throw new Error("ECS system id cannot be empty");
  const identities = new Map<string, "read" | "write">();
  for (const access of definition.accesses) {
    const identity = access_identity(access);
    const previous = identities.get(identity);
    if (previous !== undefined) {
      throw new Error(
        `ECS system ${
          JSON.stringify(id)
        } declares ${identity} as both ${previous} and ${access.mode}`,
      );
    }
    identities.set(identity, access.mode);
  }
  return Object.freeze({
    id,
    accesses: Object.freeze([...definition.accesses]),
    run: definition.run,
  });
}

export function create_schedule(systems: readonly System[]): Schedule {
  const ids = new Set<string>();
  for (const system of systems) {
    if (ids.has(system.id)) {
      throw new Error(
        `ECS schedule contains system ${
          JSON.stringify(system.id)
        } more than once`,
      );
    }
    ids.add(system.id);
  }
  const stages: { systems: System[] }[] = [];
  for (const system of systems) {
    let stage_index = 0;
    while (
      stage_index < stages.length &&
      stages[stage_index].systems.some((candidate) =>
        systems_conflict(candidate, system)
      )
    ) {
      stage_index += 1;
    }
    if (!stages[stage_index]) stages.push({ systems: [] });
    stages[stage_index].systems.push(system);
  }
  const frozen_stages = stages.map((stage) =>
    Object.freeze({ systems: Object.freeze(stage.systems.slice()) })
  );
  return Object.freeze({
    stages: Object.freeze(frozen_stages),
    run(world: World): ScheduleRunResult {
      const spawned: Entity[] = [];
      for (const [stage_index, stage] of frozen_stages.entries()) {
        const buffered_commands: StructuralCommand[] = [];
        world.begin_system_execution();
        try {
          for (const system of stage.systems) {
            const commands: StructuralCommand[] = [];
            const context = create_system_context(world, system, commands);
            try {
              system.run(context);
            } catch (error) {
              return {
                type: "failed",
                stage: stage_index,
                system: system.id,
                reason: error instanceof Error ? error.message : String(error),
              };
            }
            buffered_commands.push(...commands);
          }
        } finally {
          world.end_system_execution();
        }
        const applied = apply_commands(world, buffered_commands);
        if (applied.type === "failed") {
          return {
            type: "failed",
            stage: stage_index,
            reason: applied.reason,
          };
        }
        spawned.push(...applied.spawned);
        world.observe("schedule.barrier", {
          stage: stage_index,
          system_count: stage.systems.length,
          structural_change_count: buffered_commands.length,
        });
      }
      return {
        type: "completed",
        barriers: frozen_stages.length,
        spawned,
      };
    },
  });
}

function create_system_context(
  world: World,
  system: System,
  commands: StructuralCommand[],
): SystemContext {
  const declared = new Map(
    system.accesses.map((access) => [access_identity(access), access.mode]),
  );
  const require_access = (
    kind: "component" | "resource",
    id: string,
    required: "read" | "write",
  ) => {
    const actual = declared.get(`${kind}:${id}`);
    if (actual === undefined || (required === "write" && actual !== "write")) {
      throw new Error(
        `ECS system ${
          JSON.stringify(system.id)
        } requires ${required} access to ${kind} ${
          JSON.stringify(id)
        } but declared ${actual ?? "none"}`,
      );
    }
  };
  return {
    commands: {
      spawn(components = []) {
        commands.push({
          type: "spawn",
          components: components.map((assignment) =>
            component_value(assignment.component, assignment.value)
          ),
        });
      },
      despawn(entity) {
        commands.push({ type: "despawn", entity });
      },
      insert(entity, component, value) {
        commands.push({
          type: "insert",
          entity,
          assignment: component_value(component, value),
        });
      },
      remove(entity, component) {
        commands.push({ type: "remove", entity, component });
      },
    },
    rows(description) {
      for (const access of description.accesses) {
        require_access("component", access.component.id, access.mode);
      }
      return world.rows(description);
    },
    get(entity, component) {
      require_access("component", component.id, "read");
      return world.get(entity, component);
    },
    set(entity, component, value) {
      require_access("component", component.id, "write");
      return world.set(entity, component, value);
    },
    get_resource(resource) {
      require_access("resource", resource.id, "read");
      return world.get_resource(resource);
    },
    set_resource(resource, value) {
      require_access("resource", resource.id, "write");
      return world.set_resource(resource, value);
    },
  };
}

function apply_commands(
  world: World,
  commands: readonly StructuralCommand[],
): { readonly type: "applied"; readonly spawned: readonly Entity[] } | {
  readonly type: "failed";
  readonly reason: string;
} {
  if (commands.length === 0) return { type: "applied", spawned: [] };
  const before = world.snapshot();
  const spawned: Entity[] = [];
  for (const [command_index, command] of commands.entries()) {
    let failure: string | undefined;
    if (command.type === "spawn") {
      const result = world.spawn();
      if (result.type !== "spawned") {
        failure = `spawn returned ${result.type}`;
      } else {
        spawned.push(result.entity);
        for (const assignment of command.components) {
          const inserted = world.insert(
            result.entity,
            assignment.component,
            assignment.value,
          );
          if (inserted.type !== "changed") {
            failure = `spawn component ${
              JSON.stringify(assignment.component.id)
            } returned ${inserted.type}`;
            break;
          }
        }
      }
    } else if (command.type === "despawn") {
      const result = world.despawn(command.entity);
      if (result.type !== "changed") {
        failure = `despawn returned ${result.type}`;
      }
    } else if (command.type === "insert") {
      const result = world.insert(
        command.entity,
        command.assignment.component,
        command.assignment.value,
      );
      if (result.type !== "changed") {
        failure = `insert ${
          JSON.stringify(command.assignment.component.id)
        } returned ${result.type}`;
      }
    } else {
      const result = world.remove(command.entity, command.component);
      if (result.type !== "changed") {
        failure = `remove ${
          JSON.stringify(command.component.id)
        } returned ${result.type}`;
      }
    }
    if (failure !== undefined) {
      const restored = world.restore(before);
      if (restored.type !== "restored") {
        throw new Error(
          `ECS structural command rollback failed after command ${command_index}: ${restored.reason}`,
        );
      }
      return {
        type: "failed",
        reason: `structural command ${command_index} ${failure}`,
      };
    }
  }
  return { type: "applied", spawned };
}

function systems_conflict(left: System, right: System): boolean {
  for (const left_access of left.accesses) {
    for (const right_access of right.accesses) {
      if (access_identity(left_access) !== access_identity(right_access)) {
        continue;
      }
      if (left_access.mode === "write" || right_access.mode === "write") {
        return true;
      }
    }
  }
  return false;
}

function access_identity(access: SystemAccess): string {
  return access.type === "component_access"
    ? `component:${access.component.id}`
    : `resource:${access.resource.id}`;
}
