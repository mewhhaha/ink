import type { BlotManifest } from "./manifest.ts";
import type { GameGuest, GameState } from "./game_guest.ts";
import type {
  ActionDescription,
  DirectionalLightCommand,
  GameStatus,
  GameViewport,
  Projection,
  RenderSnapshot,
  SceneNodeCommand,
  SceneResource,
  SemanticRegion,
  SurfaceMode,
} from "./protocol.ts";
import { expand_isometric_tilemap } from "./isometric_tilemap.ts";
import { expand_isometric_component_layer } from "./isometric_component_layer.ts";
import { parse_indexed_seed, parse_resource_seed } from "./ecs_seed.ts";

interface ObjectMaterial {
  readonly color: readonly [number, number, number];
  readonly texture: number | null;
  readonly secondary_texture: number | null;
  readonly texture_scale: readonly [number, number];
  readonly blend_edges: number;
  readonly variation_seed: number;
  readonly surface_mode: SurfaceMode;
  readonly path_connections: number;
}

interface EcsWorldSchema {
  readonly base: number;
  readonly capacity: number;
  readonly component_base: number;
  readonly component_capacity: number;
  readonly component_stride: number;
  readonly entity_metadata_base: number;
  readonly entity_mode: number;
  readonly max_fields: number;
  readonly resource_base: number;
  readonly resource_capacity: number;
  readonly resource_stride: number;
}

interface EcsComponentSchema {
  readonly field_count: number;
  readonly fields: string;
  readonly id: number;
  readonly name: string;
}

interface EcsSeedSchema {
  readonly component: number;
  readonly source: string;
  readonly values: readonly (readonly bigint[])[];
}

interface EcsResourceSchema {
  readonly field_count: number;
  readonly fields: string;
  readonly id: number;
  readonly name: string;
  readonly source: string;
  readonly values: readonly bigint[];
}

interface GuestExports extends WebAssembly.Exports {
  readonly memory: WebAssembly.Memory;
  readonly "blot:default": () => void;
}

type PhaseInvocation =
  | { readonly type: "start"; readonly state: GameState }
  | {
    readonly type: "step";
    readonly state: GameState;
    readonly event_kind: number;
    readonly target: number;
    readonly value: number;
    readonly delta_us: number;
  }
  | {
    readonly type: "describe";
    readonly state: GameState;
    readonly viewport: GameViewport;
  }
  | {
    readonly type: "render";
    readonly state: GameState;
    readonly viewport: GameViewport;
  }
  | { readonly type: "schema"; readonly state: GameState };

export async function create_blot_guest(
  wasm_bytes: Uint8Array,
  _manifest: BlotManifest,
): Promise<GameGuest> {
  const memory_reference: { current?: WebAssembly.Memory } = {};
  let actions: ActionDescription[] = [];
  let regions: SemanticRegion[] = [];
  let semantic_placement:
    | { readonly id: string; readonly value: SemanticRegion["placement"] }
    | undefined;
  let semantic_style:
    | { readonly id: string; readonly value: SemanticRegion["style"] }
    | undefined;
  let status: GameStatus | undefined;
  let projection: Projection | undefined;
  let camera_zoom: number | undefined;
  let directional_light: DirectionalLightCommand | undefined;
  let nodes: SceneNodeCommand[] = [];
  let objects: RenderSnapshot["objects"] = [];
  let resources: SceneResource[] = [];
  let object_materials = new Map<number, ObjectMaterial>();
  let object_meshes = new Map<number, number>();
  let scene_tree_stack: number[] = [];
  let scene_node_ids = new Set<number>();
  let active_invocation: PhaseInvocation | undefined;
  let committed_state: bigint | undefined;
  let active_cells: bigint[] = [];
  let ecs_world_schema: EcsWorldSchema | undefined;
  const ecs_component_schemas = new Map<number, EcsComponentSchema>();
  const ecs_component_names = new Set<string>();
  const ecs_seed_schemas: EcsSeedSchema[] = [];
  const ecs_resource_schemas = new Map<number, EcsResourceSchema>();
  const ecs_resource_names = new Set<string>();

  const read_text = (pointer: number, length: number): string => {
    if (!memory_reference.current) {
      throw new Error("Blot guest memory is unavailable");
    }
    return new TextDecoder().decode(
      new Uint8Array(memory_reference.current.buffer, pointer, length),
    );
  };

  const read_ecs_component_column = (
    component_value: bigint,
    field_value: bigint,
    entity_count: number,
    context: string,
  ): readonly (bigint | undefined)[] => {
    const world = ecs_world_schema;
    if (!world) throw new Error(`${context} requires a registered ECS world`);
    if (entity_count > world.capacity) {
      throw new Error(
        `${context} has ${entity_count} entities but ECS capacity is ${world.capacity}`,
      );
    }
    const component_id = schema_integer(
      component_value,
      `${context} component`,
    );
    const component = ecs_component_schemas.get(component_id);
    if (!component) {
      throw new Error(`${context} component ${component_id} is not registered`);
    }
    const field_index = schema_integer(field_value, `${context} field`);
    if (field_index < 0 || field_index >= component.field_count) {
      throw new Error(
        `${context} field ${field_index} is outside component ${
          JSON.stringify(component.name)
        } fields`,
      );
    }
    return Array.from({ length: entity_count }, (_, entity_index) => {
      const metadata = world.entity_metadata_base + entity_index * 3;
      const alive = world.entity_mode === 1 ||
        (active_cells[metadata] ?? 0n) > 0n;
      if (!alive) return undefined;
      const generation = world.entity_mode === 1
        ? 0n
        : active_cells[metadata + 1] ?? 0n;
      const base = world.component_base +
        component_id * world.component_stride +
        entity_index * (world.max_fields + 1);
      if ((active_cells[base] ?? 0n) !== generation + 1n) return undefined;
      return active_cells[base + field_index + 1] ?? 0n;
    });
  };

  const read_required_ecs_component_column = (
    component_value: bigint,
    field_value: bigint,
    entity_count: number,
    context: string,
  ): readonly bigint[] => {
    const values = read_ecs_component_column(
      component_value,
      field_value,
      entity_count,
      context,
    );
    return values.map((value, entity) => {
      if (value === undefined) {
        throw new Error(`${context} entity ${entity} has no component`);
      }
      return value;
    });
  };

  const read_grid_entity_count = (
    columns: bigint,
    rows: bigint,
    context: string,
  ): number => {
    const column_count = schema_integer(columns, `${context} columns`);
    const row_count = schema_integer(rows, `${context} rows`);
    if (column_count <= 0 || row_count <= 0) {
      throw new Error(
        `${context} dimensions ${column_count}x${row_count} must be positive`,
      );
    }
    const entity_count = column_count * row_count;
    if (!Number.isSafeInteger(entity_count)) {
      throw new Error(`${context} entity count ${entity_count} is not safe`);
    }
    return entity_count;
  };

  const read_i64_record = (
    parameters: readonly (bigint | number)[],
    field_count: number,
    context: string,
  ): readonly bigint[] => {
    if (
      parameters.length === field_count &&
      parameters.every((value) => typeof value === "bigint")
    ) {
      return parameters as readonly bigint[];
    }
    if (parameters.length !== 1 || typeof parameters[0] !== "number") {
      throw new Error(
        `${context} received ${parameters.length} ABI values; expected ${field_count} values or one record pointer`,
      );
    }
    if (!memory_reference.current) {
      throw new Error("Blot guest memory is unavailable");
    }
    const record_pointer = parameters[0];
    const record_end = record_pointer + field_count * 8;
    if (
      !Number.isSafeInteger(record_pointer) || record_pointer < 0 ||
      record_end > memory_reference.current.buffer.byteLength
    ) {
      throw new Error(
        `${context} record range ${record_pointer}..${record_end} is outside guest memory`,
      );
    }
    const view = new DataView(memory_reference.current.buffer);
    return Array.from(
      { length: field_count },
      (_, field) => view.getBigInt64(record_pointer + field * 8, true),
    );
  };

  let next_runtime_reference = 1;
  const runtime_references = new Map<number, unknown>();
  const retain_runtime_value = (value: unknown): number => {
    const reference = next_runtime_reference;
    next_runtime_reference += 1;
    runtime_references.set(reference, value);
    return reference;
  };
  const runtime_value = (reference: number): unknown => {
    if (!Number.isSafeInteger(reference) || reference < 1) {
      throw new Error(`invalid gpupaper runtime reference ${reference}`);
    }
    const value = runtime_references.get(reference);
    if (value === undefined) {
      throw new Error(`unknown gpupaper runtime reference ${reference}`);
    }
    return value;
  };
  const gpupaper_runtime = new Proxy<Record<string, CallableFunction>>({}, {
    get: (_target, property) => {
      if (typeof property !== "string") return undefined;
      const product_make = /^product_make_(\d+)$/.exec(property);
      if (product_make !== null) {
        const field_count = Number(product_make[1]);
        return (...fields: unknown[]) => {
          if (fields.length !== field_count) {
            throw new Error(
              `${property} received ${fields.length} fields, expected ${field_count}`,
            );
          }
          return retain_runtime_value(fields);
        };
      }
      const product_project = /^product_project_(\d+)$/.exec(property);
      if (product_project !== null) {
        const field = Number(product_project[1]);
        return (reference: number) => {
          const fields = runtime_value(reference);
          if (!Array.isArray(fields) || field >= fields.length) {
            throw new Error(`${property} received a non-product reference`);
          }
          return fields[field];
        };
      }
      const sum_make = /^sum_make_(\d+)$/.exec(property);
      if (sum_make !== null) {
        const selected_case = Number(sum_make[1]);
        return (payload: unknown) =>
          retain_runtime_value({
            payload,
            selected_case,
          });
      }
      if (property === "sum_tag") {
        return (reference: number) => {
          const sum = runtime_value(reference);
          if (!is_runtime_sum(sum)) {
            throw new Error(`${property} received a non-sum reference`);
          }
          return sum.selected_case;
        };
      }
      if (property.startsWith("sum_payload_")) {
        return (reference: number) => {
          const sum = runtime_value(reference);
          if (!is_runtime_sum(sum)) {
            throw new Error(`${property} received a non-sum reference`);
          }
          return sum.payload;
        };
      }
      return undefined;
    },
  });

  const imports = {
    __gpupaper_runtime: gpupaper_runtime,
    "blot:host/Resource": {
      mesh: (id: bigint, url_pointer: number, url_length: number) => {
        resources.push({
          type: "mesh",
          id: Number(id),
          url: read_text(url_pointer, url_length),
        });
      },
      texture: (id: bigint, url_pointer: number, url_length: number) => {
        resources.push({
          type: "texture",
          id: Number(id),
          url: read_text(url_pointer, url_length),
        });
      },
    },
    "blot:host/Phase": {
      current: () => {
        const request = active_invocation;
        if (request === undefined) {
          throw new Error("Blot requested its phase outside a game step");
        }
        switch (request.type) {
          case "start":
            return 0n;
          case "step":
            return 1n;
          case "describe":
            return 2n;
          case "render":
            return 3n;
          case "schema":
            return 4n;
        }
      },
    },
    "blot:host/SceneTree": {
      enter: (id: bigint) => {
        if (active_invocation?.type !== "render") {
          throw new Error("Blot entered a scene node outside the render phase");
        }
        const node_id = schema_integer(id, "scene node id");
        if (node_id < 0) {
          throw new Error(`scene node id ${node_id} must be nonnegative`);
        }
        const parent = scene_tree_stack.at(-1) ?? -1;
        scene_tree_stack.push(node_id);
        return BigInt(parent);
      },
      leave: (id: bigint) => {
        if (active_invocation?.type !== "render") {
          throw new Error("Blot left a scene node outside the render phase");
        }
        const node_id = schema_integer(id, "scene node id");
        const active_node = scene_tree_stack.at(-1);
        if (active_node !== node_id) {
          throw new Error(
            `scene node ${node_id} cannot leave while ${
              active_node ?? "no node"
            } is active`,
          );
        }
        scene_tree_stack.pop();
      },
    },
    "blot:host/State": {
      current: () => {
        const request = active_invocation;
        if (request === undefined) {
          throw new Error("Blot requested state outside a game step");
        }
        return request.state.scalar;
      },
      commit: (state: bigint) => {
        if (active_invocation === undefined) {
          throw new Error("Blot committed state outside a game step");
        }
        if (committed_state !== undefined) {
          throw new Error("Blot committed game state more than once");
        }
        committed_state = state;
      },
    },
    "blot:host/Cells": {
      get: (index: bigint) => {
        const cell_index = Number(index);
        if (!Number.isSafeInteger(cell_index) || cell_index < 0) {
          throw new Error(
            `Blot cell index ${index} is not a non-negative safe integer`,
          );
        }
        if (cell_index > 262_143) {
          throw new Error(`Blot cell index ${cell_index} exceeds 262,143`);
        }
        return active_cells[cell_index] ?? 0n;
      },
      put: (index: bigint, value: bigint) => {
        const request = active_invocation;
        if (request?.type !== "start" && request?.type !== "step") {
          throw new Error("Blot changed a cell outside a state phase");
        }
        const cell_index = Number(index);
        if (!Number.isSafeInteger(cell_index) || cell_index < 0) {
          throw new Error(
            `Blot cell index ${index} is not a non-negative safe integer`,
          );
        }
        if (cell_index > 262_143) {
          throw new Error(`Blot cell index ${cell_index} exceeds 262,143`);
        }
        while (active_cells.length <= cell_index) active_cells.push(0n);
        active_cells[cell_index] = value;
      },
    },
    "blot:host/EcsSchema": {
      world: (
        base: bigint,
        capacity: bigint,
        component_base: bigint,
        component_capacity: bigint,
        component_stride: bigint,
        entity_metadata_base: bigint,
        entity_mode: bigint,
        max_fields: bigint,
        resource_base: bigint,
        resource_capacity: bigint,
        resource_stride: bigint,
      ) => {
        if (active_invocation?.type !== "schema") {
          throw new Error("Blot registered an ECS world outside schema phase");
        }
        if (ecs_world_schema) {
          throw new Error("Blot registered more than one ECS world");
        }
        const schema = {
          base: schema_integer(base, "ECS world base"),
          capacity: schema_integer(capacity, "ECS entity capacity"),
          component_base: schema_integer(
            component_base,
            "ECS component base",
          ),
          component_capacity: schema_integer(
            component_capacity,
            "ECS component capacity",
          ),
          component_stride: schema_integer(
            component_stride,
            "ECS component stride",
          ),
          entity_metadata_base: schema_integer(
            entity_metadata_base,
            "ECS entity metadata base",
          ),
          entity_mode: schema_integer(entity_mode, "ECS entity mode"),
          max_fields: schema_integer(max_fields, "ECS maximum field count"),
          resource_base: schema_integer(resource_base, "ECS resource base"),
          resource_capacity: schema_integer(
            resource_capacity,
            "ECS resource capacity",
          ),
          resource_stride: schema_integer(
            resource_stride,
            "ECS resource stride",
          ),
        };
        if (
          schema.base < 0 || schema.component_base < 0 ||
          schema.entity_metadata_base < 0 || schema.resource_base < 0
        ) {
          throw new Error(
            `ECS world bases ${schema.base}, ${schema.entity_metadata_base}, and ${schema.component_base} must be nonnegative`,
          );
        }
        if (
          schema.capacity <= 0 || schema.component_capacity < 0 ||
          schema.resource_capacity < 0 ||
          schema.component_stride <= 0 || schema.max_fields <= 0
        ) {
          throw new Error(
            `ECS world capacities ${schema.capacity}, ${schema.component_capacity}, stride ${schema.component_stride}, and field count ${schema.max_fields} must be positive`,
          );
        }
        if (schema.entity_mode !== 0 && schema.entity_mode !== 1) {
          throw new Error(
            `ECS entity mode ${schema.entity_mode} must be 0 or 1`,
          );
        }
        if (schema.max_fields > 8) {
          throw new Error(
            `ECS maximum field count ${schema.max_fields} exceeds 8`,
          );
        }
        const minimum_component_stride = schema.capacity *
          (schema.max_fields + 1);
        if (schema.component_stride < minimum_component_stride) {
          throw new Error(
            `ECS component stride ${schema.component_stride} is smaller than ${minimum_component_stride}`,
          );
        }
        const entity_metadata_end = schema.entity_metadata_base +
          (schema.entity_mode === 0 ? schema.capacity * 3 : 0);
        if (
          schema.entity_metadata_base < schema.base ||
          schema.component_base < entity_metadata_end
        ) {
          throw new Error(
            `ECS ranges ${schema.base}, ${schema.entity_metadata_base}..${entity_metadata_end}, and ${schema.component_base} overlap or are out of order`,
          );
        }
        const end = schema.component_base +
          schema.component_capacity * schema.component_stride;
        if (schema.resource_base < end) {
          throw new Error(
            `ECS resource base ${schema.resource_base} overlaps component range ending at ${end}`,
          );
        }
        if (schema.resource_stride < schema.max_fields) {
          throw new Error(
            `ECS resource stride ${schema.resource_stride} is smaller than ${schema.max_fields}`,
          );
        }
        const resource_end = schema.resource_base +
          schema.resource_capacity * schema.resource_stride;
        if (!Number.isSafeInteger(resource_end) || resource_end > 262_144) {
          throw new Error(
            `ECS world cell range ends at ${resource_end}; maximum is 262144`,
          );
        }
        ecs_world_schema = schema;
      },
      component: (
        field_count: bigint,
        fields_pointer: number,
        fields_length: number,
        id: bigint,
        name_pointer: number,
        name_length: number,
      ) => {
        if (active_invocation?.type !== "schema") {
          throw new Error(
            "Blot registered an ECS component outside schema phase",
          );
        }
        const world = ecs_world_schema;
        if (!world) {
          throw new Error("Blot registered an ECS component before its world");
        }
        const schema = {
          field_count: schema_integer(
            field_count,
            "ECS component field count",
          ),
          fields: read_text(fields_pointer, fields_length),
          id: schema_integer(id, "ECS component id"),
          name: read_text(name_pointer, name_length),
        };
        if (schema.id < 0 || schema.id >= world.component_capacity) {
          throw new Error(
            `ECS component ${
              JSON.stringify(schema.name)
            } id ${schema.id} is outside 0..${world.component_capacity - 1}`,
          );
        }
        if (schema.field_count <= 0 || schema.field_count > world.max_fields) {
          throw new Error(
            `ECS component ${
              JSON.stringify(schema.name)
            } field count ${schema.field_count} is outside 1..${world.max_fields}`,
          );
        }
        if (schema.name.length === 0) {
          throw new Error("ECS component name must not be empty");
        }
        assert_ecs_fields(
          schema.fields,
          schema.field_count,
          "component",
          schema.name,
        );
        if (ecs_component_schemas.has(schema.id)) {
          throw new Error(`ECS component id ${schema.id} is registered twice`);
        }
        if (ecs_component_names.has(schema.name)) {
          throw new Error(
            `ECS component name ${
              JSON.stringify(schema.name)
            } is registered twice`,
          );
        }
        ecs_component_schemas.set(schema.id, schema);
        ecs_component_names.add(schema.name);
      },
      resource: (
        field_count: bigint,
        fields_pointer: number,
        fields_length: number,
        id: bigint,
        name_pointer: number,
        name_length: number,
        source_pointer: number,
        source_length: number,
      ) => {
        if (active_invocation?.type !== "schema") {
          throw new Error(
            "Blot registered an ECS resource outside schema phase",
          );
        }
        const world = ecs_world_schema;
        if (!world) {
          throw new Error("Blot registered an ECS resource before its world");
        }
        const schema = {
          field_count: schema_integer(
            field_count,
            "ECS resource field count",
          ),
          fields: read_text(fields_pointer, fields_length),
          id: schema_integer(id, "ECS resource id"),
          name: read_text(name_pointer, name_length),
          source: read_text(source_pointer, source_length),
        };
        if (schema.id < 0 || schema.id >= world.resource_capacity) {
          throw new Error(
            `ECS resource ${
              JSON.stringify(schema.name)
            } id ${schema.id} is outside 0..${world.resource_capacity - 1}`,
          );
        }
        if (schema.field_count <= 0 || schema.field_count > world.max_fields) {
          throw new Error(
            `ECS resource ${
              JSON.stringify(schema.name)
            } field count ${schema.field_count} is outside 1..${world.max_fields}`,
          );
        }
        if (schema.name.length === 0) {
          throw new Error("ECS resource name must not be empty");
        }
        assert_ecs_fields(
          schema.fields,
          schema.field_count,
          "resource",
          schema.name,
        );
        if (ecs_resource_schemas.has(schema.id)) {
          throw new Error(`ECS resource id ${schema.id} is registered twice`);
        }
        if (ecs_resource_names.has(schema.name)) {
          throw new Error(
            `ECS resource name ${
              JSON.stringify(schema.name)
            } is registered twice`,
          );
        }
        ecs_resource_schemas.set(schema.id, {
          ...schema,
          values: parse_resource_seed(schema.source, schema.field_count),
        });
        ecs_resource_names.add(schema.name);
      },
      seed_indexed: (
        component: bigint,
        source_pointer: number,
        source_length: number,
        world_base: bigint,
      ) => {
        if (active_invocation?.type !== "schema") {
          throw new Error("Blot registered an ECS seed outside schema phase");
        }
        const world = ecs_world_schema;
        if (!world) {
          throw new Error("Blot registered an ECS seed before its world");
        }
        if (world.entity_mode !== 1) {
          throw new Error("ECS seeds require an indexed world");
        }
        const registered_base = schema_integer(world_base, "ECS seed world");
        if (registered_base !== world.base) {
          throw new Error(
            `ECS seed world ${registered_base} does not match registered world ${world.base}`,
          );
        }
        const component_id = schema_integer(component, "ECS seed component");
        const registered_component = ecs_component_schemas.get(component_id);
        if (!registered_component) {
          throw new Error(
            `ECS seed component ${component_id} is not registered`,
          );
        }
        if (
          ecs_seed_schemas.some((seed) => seed.component === component_id)
        ) {
          throw new Error(`ECS component ${component_id} has two seeds`);
        }
        const source = read_text(source_pointer, source_length);
        ecs_seed_schemas.push({
          component: component_id,
          source,
          values: parse_indexed_seed(
            source,
            registered_component.field_count,
            world.capacity,
          ),
        });
      },
    },
    "blot:host/Viewport": {
      current: (result_pointer: number) => {
        const request = active_invocation;
        if (request?.type !== "describe" && request?.type !== "render") {
          throw new Error(
            "Blot requested the viewport outside an output phase",
          );
        }
        if (!memory_reference.current) {
          throw new Error("Blot guest memory is unavailable");
        }
        const view = new DataView(memory_reference.current.buffer);
        view.setBigInt64(
          result_pointer,
          BigInt(request.viewport.height),
          true,
        );
        view.setBigInt64(
          result_pointer + 8,
          BigInt(request.viewport.width),
          true,
        );
      },
    },
    "blot:host/Events": {
      next: (result_pointer: number) => {
        const request = active_invocation;
        if (request?.type !== "step") {
          throw new Error("Blot requested an event outside a game step");
        }
        if (!memory_reference.current) {
          throw new Error("Blot guest memory is unavailable");
        }
        const view = new DataView(memory_reference.current.buffer);
        view.setBigInt64(result_pointer, BigInt(request.event_kind), true);
        view.setBigInt64(result_pointer + 8, BigInt(request.target), true);
        view.setBigInt64(result_pointer + 16, BigInt(request.value), true);
      },
    },
    "blot:host/Time": {
      delta_us: () => {
        const request = active_invocation;
        if (request?.type !== "step") {
          throw new Error("Blot requested delta time outside a game step");
        }
        return BigInt(request.delta_us);
      },
    },
    "blot:host/Semantic": {
      action: (
        id_pointer: number,
        id_length: number,
        kind: bigint,
        label_pointer: number,
        label_length: number,
        target: bigint,
        value: bigint,
      ) => {
        const id = read_text(id_pointer, id_length);
        actions.push({
          id,
          label: read_text(label_pointer, label_length),
          action: {
            type: "custom",
            kind: Number(kind),
            target: Number(target),
            value: Number(value),
          },
        });
      },
      placement: (
        id_pointer: number,
        id_length: number,
        object: bigint,
        offset_x: bigint,
        offset_y: bigint,
        offset_z: bigint,
        plane_height: bigint,
        plane_width: bigint,
      ) => {
        const id = read_text(id_pointer, id_length);
        if (semantic_placement !== undefined) {
          throw new Error(
            `semantic element ${
              JSON.stringify(semantic_placement.id)
            } omitted its element operation`,
          );
        }
        if (Number(object) >= 0) {
          semantic_placement = {
            id,
            value: {
              type: "scene_object",
              object: Number(object),
              offset: [Number(offset_x), Number(offset_y), Number(offset_z)],
              size: [Number(plane_width), Number(plane_height)],
            },
          };
          return;
        }
        let anchor: Extract<
          SemanticRegion["placement"],
          { type: "viewport" }
        >["anchor"];
        switch (Number(object)) {
          case -1:
            anchor = "top_left";
            break;
          case -2:
            anchor = "top_right";
            break;
          case -3:
            anchor = "bottom_left";
            break;
          case -4:
            anchor = "bottom_right";
            break;
          case -5:
            anchor = "center";
            break;
          default:
            throw new Error(
              `semantic viewport anchor ${object} is not supported`,
            );
        }
        semantic_placement = {
          id,
          value: {
            type: "viewport",
            anchor,
            inset: [Number(offset_x), Number(offset_y)],
          },
        };
      },
      style: (
        id_pointer: number,
        id_length: number,
        background_color_pointer: number,
        background_color_length: number,
        border_color_pointer: number,
        border_color_length: number,
        border_radius: bigint,
        border_width: bigint,
        color_pointer: number,
        color_length: number,
        font_size: bigint,
        font_weight: bigint,
      ) => {
        const id = read_text(id_pointer, id_length);
        if (semantic_style !== undefined) {
          throw new Error(
            `semantic element ${
              JSON.stringify(semantic_style.id)
            } omitted its element operation`,
          );
        }
        semantic_style = {
          id,
          value: {
            background_color: read_text(
              background_color_pointer,
              background_color_length,
            ),
            border_color: read_text(
              border_color_pointer,
              border_color_length,
            ),
            border_radius: Number(border_radius),
            border_width: Number(border_width),
            color: read_text(color_pointer, color_length),
            font_size: Number(font_size),
            font_weight: Number(font_weight),
          },
        };
      },
      element: (
        description_pointer: number,
        description_length: number,
        element_height: bigint,
        element_width: bigint,
        id_pointer: number,
        id_length: number,
        kind: bigint,
        label_pointer: number,
        label_length: number,
        maximum: bigint,
        order: bigint,
        pressed: number,
        selected: number,
        target: bigint,
        value: bigint,
      ) => {
        const id = read_text(id_pointer, id_length);
        if (semantic_placement?.id !== id) {
          throw new Error(
            `semantic element ${JSON.stringify(id)} has no matching placement`,
          );
        }
        if (semantic_style?.id !== id) {
          throw new Error(
            `semantic element ${JSON.stringify(id)} has no matching style`,
          );
        }
        const common_region = {
          id,
          label: read_text(label_pointer, label_length),
          description: read_text(description_pointer, description_length),
          element_size: {
            width: Number(element_width),
            height: Number(element_height),
          },
          placement: semantic_placement.value,
          style: semantic_style.value,
          order: Number(order),
        } as const;
        semantic_placement = undefined;
        semantic_style = undefined;
        if (kind === 0n) {
          regions.push({
            ...common_region,
            role: "button",
            target: Number(target),
            pressed: pressed !== 0,
            selected: selected !== 0,
            actions: [
              {
                id: `focus:${id}`,
                label: `Focus ${id}`,
                action: { type: "focus", target: Number(target) },
              },
              {
                id: `activate:${id}`,
                label: `Activate ${id}`,
                action: { type: "activate", target: Number(target) },
              },
            ],
          });
          return;
        }
        if (kind === 1n) {
          regions.push({ ...common_region, role: "text", actions: [] });
          return;
        }
        if (kind === 2n) {
          regions.push({
            ...common_region,
            role: "progress",
            maximum: Number(maximum),
            value: Number(value),
            actions: [],
          });
          return;
        }
        throw new Error(
          `semantic element ${JSON.stringify(id)} has unsupported kind ${kind}`,
        );
      },
      status: (
        done: number,
        label_pointer: number,
        label_length: number,
        value_pointer: number,
        value_length: number,
      ) => {
        status = {
          done: done !== 0,
          label: read_text(label_pointer, label_length),
          value: read_text(value_pointer, value_length),
        };
      },
    },
    "blot:host/Render": {
      directional_light: (
        color_blue: bigint,
        color_green: bigint,
        color_red: bigint,
        direction_x: bigint,
        direction_y: bigint,
        direction_z: bigint,
        intensity: bigint,
      ) => {
        if (directional_light !== undefined) {
          throw new Error("Blot rendered more than one directional light");
        }
        directional_light = {
          type: "directional_light",
          color: [
            Number(color_red) / 1_000_000,
            Number(color_green) / 1_000_000,
            Number(color_blue) / 1_000_000,
          ],
          direction: [
            Number(direction_x) / 1_000_000,
            Number(direction_y) / 1_000_000,
            Number(direction_z) / 1_000_000,
          ],
          intensity: Number(intensity) / 1_000_000,
        };
      },
      isometric_tilemap: (...parameters: (bigint | number)[]) => {
        const [
          blend_field,
          columns,
          detail_field,
          detail_scale,
          first_object_id,
          ground_mesh,
          origin_y,
          path_field,
          road_texture,
          rows,
          secondary_texture,
          terrain_component,
          terrain_field,
          texture_scale_x,
          texture_scale_y,
          tile_half_height,
          tile_half_width,
          tile_scale,
          variation_seed,
        ] = read_i64_record(parameters, 19, "isometric tilemap");
        const tile_count = read_grid_entity_count(
          columns,
          rows,
          "isometric tilemap",
        );
        const terrain_textures = read_required_ecs_component_column(
          terrain_component,
          terrain_field,
          tile_count,
          "isometric tilemap",
        );
        const blend_edges = read_required_ecs_component_column(
          terrain_component,
          blend_field,
          tile_count,
          "isometric tilemap",
        );
        const path_connections = read_required_ecs_component_column(
          terrain_component,
          path_field,
          tile_count,
          "isometric tilemap",
        );
        const detail_textures = read_required_ecs_component_column(
          terrain_component,
          detail_field,
          tile_count,
          "isometric tilemap",
        );
        const tilemap_objects = expand_isometric_tilemap(
          {
            columns,
            detail_scale,
            first_object_id,
            ground_mesh,
            origin_y,
            road_texture,
            rows,
            secondary_texture,
            tile_half_height,
            tile_half_width,
            tile_scale,
            texture_scale_x,
            texture_scale_y,
            variation_seed,
          },
          Array.from({ length: tile_count }, (_, entity) => ({
            terrain_texture: terrain_textures[entity],
            blend_edges: blend_edges[entity],
            path_connections: path_connections[entity],
            detail_texture: detail_textures[entity],
          })),
        );
        objects = [...objects, ...tilemap_objects];
      },
      isometric_component_layer: (...parameters: (bigint | number)[]) => {
        const [
          blend_edges,
          color_blue,
          color_green,
          color_red,
          columns,
          component,
          connection_mode,
          emissive,
          field,
          first_object_id,
          match_value,
          mesh,
          origin_y,
          rows,
          scale_x,
          scale_y,
          scale_z,
          secondary_texture,
          surface_mode,
          texture,
          texture_scale_x,
          texture_scale_y,
          tile_half_height,
          tile_half_width,
          variation_seed,
          z,
        ] = read_i64_record(parameters, 26, "isometric component layer");
        const tile_count = read_grid_entity_count(
          columns,
          rows,
          "isometric component layer",
        );
        const component_values = read_ecs_component_column(
          component,
          field,
          tile_count,
          "isometric component layer",
        );
        objects = [
          ...objects,
          ...expand_isometric_component_layer({
            blend_edges,
            color_blue,
            color_green,
            color_red,
            columns,
            connection_mode,
            emissive,
            first_object_id,
            match_value,
            mesh,
            origin_y,
            rows,
            scale_x,
            scale_y,
            scale_z,
            secondary_texture,
            surface_mode,
            texture,
            texture_scale_x,
            texture_scale_y,
            tile_half_height,
            tile_half_width,
            variation_seed,
            z,
          }, component_values),
        ];
      },
      mesh: (id: bigint, mesh: bigint) => {
        object_meshes.set(Number(id), Number(mesh));
      },
      node: (
        id: bigint,
        parent: bigint,
        rotation_x_microradians: bigint,
        rotation_y_microradians: bigint,
        rotation_z_microradians: bigint,
        scale_x: bigint,
        scale_y: bigint,
        scale_z: bigint,
        visible: number,
        x: bigint,
        y: bigint,
        z: bigint,
      ) => {
        const node_id = Number(id);
        register_scene_node(scene_node_ids, node_id);
        validate_tree_parent(scene_tree_stack, node_id, Number(parent));
        nodes.push({
          type: "scene_node",
          id: node_id,
          parent: parent < 0n ? null : Number(parent),
          rotation_radians: [
            Number(rotation_x_microradians) / 1_000_000,
            Number(rotation_y_microradians) / 1_000_000,
            Number(rotation_z_microradians) / 1_000_000,
          ],
          position: [Number(x), Number(y), Number(z)],
          scale: [Number(scale_x), Number(scale_y), Number(scale_z)],
          visible: visible !== 0,
        });
      },
      material: (
        blend_edges: bigint,
        color_blue: bigint,
        color_green: bigint,
        color_red: bigint,
        id: bigint,
        path_connections: bigint,
        secondary_texture: bigint,
        surface_mode: bigint,
        texture: bigint,
        texture_scale_x: bigint,
        texture_scale_y: bigint,
        variation_seed: bigint,
      ) => {
        if (surface_mode < 0n || surface_mode > 2n) {
          throw new Error(
            `scene object ${id} emitted unsupported surface mode ${surface_mode}`,
          );
        }
        if (path_connections < 0n || path_connections > 15n) {
          throw new Error(
            `scene object ${id} emitted invalid path connections ${path_connections}`,
          );
        }
        object_materials.set(Number(id), {
          color: [
            Number(color_red) / 1_000_000,
            Number(color_green) / 1_000_000,
            Number(color_blue) / 1_000_000,
          ],
          texture: texture < 0n ? null : Number(texture),
          secondary_texture: secondary_texture < 0n
            ? null
            : Number(secondary_texture),
          texture_scale: [
            Number(texture_scale_x) / 1_000_000,
            Number(texture_scale_y) / 1_000_000,
          ],
          blend_edges: Number(blend_edges),
          variation_seed: Number(variation_seed),
          surface_mode: Number(surface_mode) as SurfaceMode,
          path_connections: Number(path_connections),
        });
      },
      object: (
        emissive: bigint,
        id: bigint,
        parent: bigint,
        rotation_x_microradians: bigint,
        rotation_y_microradians: bigint,
        rotation_z_microradians: bigint,
        scale_x: bigint,
        scale_y: bigint,
        scale_z: bigint,
        visible: number,
        x: bigint,
        y: bigint,
        z: bigint,
      ) => {
        const object_id = Number(id);
        register_scene_node(scene_node_ids, object_id);
        if (scene_tree_stack.at(-1) === object_id) {
          validate_tree_parent(scene_tree_stack, object_id, Number(parent));
        }
        const mesh = object_meshes.get(object_id);
        if (mesh === undefined) {
          throw new Error(`scene object ${object_id} did not select a mesh`);
        }
        const material = object_materials.get(object_id);
        if (material === undefined) {
          throw new Error(`scene object ${object_id} did not emit a material`);
        }
        objects = [...objects, {
          type: "scene_object" as const,
          id: object_id,
          mesh,
          parent: parent < 0n ? null : Number(parent),
          color: material.color,
          emissive: Number(emissive) / 1_000_000,
          texture: material.texture,
          secondary_texture: material.secondary_texture,
          texture_scale: material.texture_scale,
          blend_edges: material.blend_edges,
          variation_seed: material.variation_seed,
          surface_mode: material.surface_mode,
          path_connections: material.path_connections,
          rotation_radians: [
            Number(rotation_x_microradians) / 1_000_000,
            Number(rotation_y_microradians) / 1_000_000,
            Number(rotation_z_microradians) / 1_000_000,
          ],
          position: [Number(x), Number(y), Number(z)] as const,
          scale: [Number(scale_x), Number(scale_y), Number(scale_z)] as const,
          visible: visible !== 0,
        }];
      },
      projection: (value: bigint) => {
        projection = value === 0n ? "perspective" : "orthographic";
      },
      zoom: (value: bigint) => {
        if (value <= 0n) {
          throw new Error(`Blot emitted nonpositive camera zoom ${value}`);
        }
        camera_zoom = Number(value) / 1_000_000;
      },
    },
  };

  const module = await WebAssembly.compile(new Uint8Array(wasm_bytes).buffer);
  const expanded_imports = Object.fromEntries(
    Object.entries(imports).map(([module_name, operations]) => {
      if (module_name === "__gpupaper_runtime") {
        return [module_name, operations];
      }
      return [
        module_name,
        Object.fromEntries(
          Object.entries(operations).map(([operation_name, operation]) => [
            operation_name,
            (...parameters: unknown[]) => {
              if (
                parameters.length === 1 && typeof parameters[0] === "number"
              ) {
                const product = runtime_references.get(parameters[0]);
                if (Array.isArray(product)) {
                  return operation(...product);
                }
              }
              return operation(...parameters);
            },
          ]),
        ),
      ];
    }),
  );
  const instantiated = await WebAssembly.instantiate(module, expanded_imports);
  const guest = instantiated.exports as GuestExports;
  memory_reference.current = guest.memory;

  const run_phase = (request: PhaseInvocation): bigint | undefined => {
    if (active_invocation !== undefined) {
      throw new Error("Blot game phases cannot be nested");
    }
    active_invocation = request;
    next_runtime_reference = 1;
    runtime_references.clear();
    active_cells = [...request.state.cells];
    if (request.type === "start") {
      const world = ecs_world_schema;
      if (world) {
        for (const resource of ecs_resource_schemas.values()) {
          for (const [field, value] of resource.values.entries()) {
            const cell = world.resource_base +
              resource.id * world.resource_stride + field;
            while (active_cells.length <= cell) active_cells.push(0n);
            active_cells[cell] = value;
          }
        }
        for (const seed of ecs_seed_schemas) {
          const rows_width = world.capacity * (world.max_fields + 1);
          const count_cell = world.component_base +
            seed.component * world.component_stride + rows_width;
          const dense_base = count_cell + 1;
          const sparse_base = dense_base + world.capacity;
          while (active_cells.length <= sparse_base + world.capacity - 1) {
            active_cells.push(0n);
          }
          active_cells[count_cell] = BigInt(seed.values.length);
          for (const [entity, fields] of seed.values.entries()) {
            const base = world.component_base +
              seed.component * world.component_stride +
              entity * (world.max_fields + 1);
            active_cells[base] = 1n;
            active_cells[dense_base + entity] = BigInt(entity);
            active_cells[sparse_base + entity] = BigInt(entity + 1);
            for (const [field, value] of fields.entries()) {
              active_cells[base + field + 1] = value;
            }
          }
        }
      }
    }
    committed_state = undefined;
    try {
      guest["blot:default"]();
      return committed_state;
    } finally {
      active_invocation = undefined;
    }
  };

  const run_state_phase = (request: PhaseInvocation): GameState => {
    const next_scalar = run_phase(request);
    if (next_scalar === undefined) {
      throw new Error(
        `Blot ${request.type} phase did not commit state`,
      );
    }
    while (active_cells.at(-1) === 0n) active_cells.pop();
    return { scalar: next_scalar, cells: active_cells };
  };

  const unexpected_schema_state = run_phase({
    type: "schema",
    state: { scalar: 0n, cells: [] },
  });
  if (unexpected_schema_state !== undefined) {
    throw new Error("Blot schema phase unexpectedly committed game state");
  }
  const state_schema = ecs_world_schema
    ? JSON.stringify({
      world: ecs_world_schema,
      components: [...ecs_component_schemas.values()].sort((left, right) =>
        left.id - right.id
      ),
      seeds: ecs_seed_schemas
        .toSorted((left, right) => left.component - right.component)
        .map(({ component, source }) => ({ component, source })),
      resources: [...ecs_resource_schemas.values()]
        .sort((left, right) => left.id - right.id)
        .map(({ field_count, fields, id, name, source }) => ({
          field_count,
          fields,
          id,
          name,
          source,
        })),
    })
    : "";

  return {
    state_schema,
    start() {
      return run_state_phase({
        type: "start",
        state: { scalar: 0n, cells: [] },
      });
    },
    step(state, event_kind, target, value, delta_us) {
      return run_state_phase({
        type: "step",
        state,
        event_kind,
        target,
        value,
        delta_us,
      });
    },
    describe(state, viewport) {
      actions = [];
      regions = [];
      semantic_placement = undefined;
      semantic_style = undefined;
      status = undefined;
      const unexpected_state = run_phase({
        type: "describe",
        state,
        viewport,
      });
      if (unexpected_state !== undefined) {
        throw new Error("Blot description unexpectedly committed game state");
      }
      if (!status) throw new Error("Blot describe did not emit a game status");
      return {
        actions,
        regions: [...regions].sort((left, right) => left.order - right.order),
        status,
      };
    },
    render(state, viewport) {
      nodes = [];
      objects = [];
      resources = [];
      object_materials = new Map();
      object_meshes = new Map();
      scene_tree_stack = [];
      scene_node_ids = new Set();
      projection = undefined;
      camera_zoom = undefined;
      directional_light = undefined;
      const unexpected_state = run_phase({
        type: "render",
        state,
        viewport,
      });
      if (unexpected_state !== undefined) {
        throw new Error("Blot rendering unexpectedly committed game state");
      }
      if (scene_tree_stack.length > 0) {
        throw new Error(
          `Blot render left scene node ${scene_tree_stack.at(-1)} active`,
        );
      }
      if (projection === undefined) {
        throw new Error("Blot render did not emit a projection");
      }
      if (camera_zoom === undefined) {
        throw new Error("Blot render did not emit a camera zoom");
      }
      if (directional_light === undefined) {
        throw new Error("Blot render did not emit a directional light");
      }
      return {
        projection,
        camera_zoom,
        directional_light,
        nodes,
        objects,
        resources,
      };
    },
  };
}

function register_scene_node(identities: Set<number>, id: number): void {
  if (!Number.isSafeInteger(id) || id < 0) {
    throw new Error(`scene node id ${id} must be a nonnegative safe integer`);
  }
  if (identities.has(id)) {
    throw new Error(`scene node id ${id} was emitted more than once`);
  }
  identities.add(id);
}

function validate_tree_parent(
  stack: readonly number[],
  id: number,
  parent: number,
): void {
  const active_node = stack.at(-1);
  if (active_node !== id) {
    throw new Error(
      `scene node ${id} emitted while ${active_node ?? "no node"} is active`,
    );
  }
  const expected_parent = stack.at(-2) ?? -1;
  if (parent !== expected_parent) {
    throw new Error(
      `scene node ${id} parent ${parent} does not match active parent ${expected_parent}`,
    );
  }
}

function schema_integer(value: bigint, field: string): number {
  const integer = Number(value);
  if (!Number.isSafeInteger(integer)) {
    throw new Error(`${field} ${value} is not a safe integer`);
  }
  return integer;
}

function is_runtime_sum(
  value: unknown,
): value is { readonly payload: unknown; readonly selected_case: number } {
  if (typeof value !== "object" || value === null) return false;
  return "payload" in value && typeof (value as {
        readonly selected_case?: unknown;
      }).selected_case === "number";
}

function assert_ecs_fields(
  source: string,
  field_count: number,
  target_kind: "component" | "resource",
  target_name: string,
): void {
  const fields = source.split(";");
  if (fields.length !== field_count) {
    throw new Error(
      `ECS ${target_kind} ${
        JSON.stringify(target_name)
      } declares ${field_count} fields but its schema contains ${fields.length}`,
    );
  }

  const field_names = new Set<string>();
  for (const field of fields) {
    const separator = field.indexOf(":");
    const field_name = field.slice(0, separator);
    const field_type = field.slice(separator + 1);
    if (separator <= 0 || field_type.length === 0) {
      throw new Error(
        `ECS ${target_kind} ${
          JSON.stringify(target_name)
        } has invalid field schema ${JSON.stringify(field)}`,
      );
    }
    if (field_names.has(field_name)) {
      throw new Error(
        `ECS ${target_kind} ${JSON.stringify(target_name)} declares field ${
          JSON.stringify(field_name)
        } twice`,
      );
    }
    field_names.add(field_name);
  }
}
