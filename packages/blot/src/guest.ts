import type { BlotManifest } from "./manifest.ts";
import type { GameGuest, GameState } from "./game_guest.ts";
import type {
  ActionDescription,
  BlotHostEffect,
  DirectionalLightCommand,
  GameStatus,
  GameViewport,
  RenderCameraCommand,
  RenderEnvironmentCommand,
  RenderSnapshot,
  SceneNodeCommand,
  SceneObjectCommand,
  SceneResource,
  SurfaceMode,
} from "./protocol.ts";
import { parse_indexed_seed, parse_resource_seed } from "./ecs_seed.ts";
import type { BlotIntegerDataAsset } from "./data_asset.ts";
import { asset_id } from "@ink/assets/identity.ts";
import { vec2, vec3 } from "@ink/math/vector.ts";
import { scene_node_id } from "@ink/scene/identity.ts";
import {
  literal_text,
  type SemanticNode,
  ui_id,
  type UiPlacement,
  UiSnapshotStore,
} from "@ink/ui/semantic.ts";
import {
  blot_abi_registry,
  type BlotHostImportImplementations,
  create_blot_host_import_modules,
  parse_blot_guest_exports,
  require_blot_module_imports,
} from "./abi.ts";

interface ObjectMaterial {
  readonly color: readonly [number, number, number];
  readonly texture: number | null;
  readonly secondary_texture: number | null;
  readonly texture_offset: readonly [number, number];
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

const maximum_safe_fixed_point = BigInt(Number.MAX_SAFE_INTEGER);

function fixed_point_number(value: bigint, label: string): number {
  if (value < -maximum_safe_fixed_point || value > maximum_safe_fixed_point) {
    throw new Error(
      `Blot ${label} ${value} exceeds the safe fixed-point range`,
    );
  }
  return Number(value) / 1_000_000;
}

function fixed_point_vector(
  x: bigint,
  y: bigint,
  z: bigint,
  label: string,
): readonly [number, number, number] {
  return [
    fixed_point_number(x, `${label} x`),
    fixed_point_number(y, `${label} y`),
    fixed_point_number(z, `${label} z`),
  ];
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

export interface BlotGuestInstantiation {
  instantiate(
    module: WebAssembly.Module,
    imports: WebAssembly.Imports,
  ): Promise<WebAssembly.Instance>;
}

export async function create_blot_guest(
  wasm_bytes: Uint8Array,
  manifest: BlotManifest,
  data_assets: readonly BlotIntegerDataAsset[] = [],
  instantiation?: BlotGuestInstantiation,
): Promise<GameGuest> {
  if (!(wasm_bytes instanceof Uint8Array)) {
    throw new Error("Blot WebAssembly artifact must be a Uint8Array");
  }
  const memory_reference: { current?: WebAssembly.Memory } = {};
  let actions: ActionDescription[] = [];
  let ui_nodes: SemanticNode[] = [];
  let ui_placement:
    | { readonly id: string; readonly value: UiPlacement }
    | undefined;
  let host_effects: BlotHostEffect[] = [];
  let status: GameStatus | undefined;
  let camera: RenderCameraCommand | undefined;
  let directional_light: DirectionalLightCommand | undefined;
  let environment: RenderEnvironmentCommand | undefined;
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
  const integer_data_assets = new Map<number, BlotIntegerDataAsset>();
  for (const asset of data_assets) {
    if (integer_data_assets.has(asset.id)) {
      throw new Error(`Blot data asset id ${asset.id} is repeated`);
    }
    integer_data_assets.set(asset.id, asset);
  }

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
    Resource: {
      mesh: ({ asset, id }) => {
        resources.push({
          type: "mesh",
          id: Number(id),
          asset: asset_id<"mesh">(asset),
        });
      },
      texture: ({ asset, id }) => {
        resources.push({
          type: "texture",
          id: Number(id),
          asset: asset_id<"texture">(asset),
        });
      },
    },
    Phase: {
      current: () => {
        const request = active_invocation;
        if (request === undefined) {
          throw new Error("Blot requested its phase outside a game step");
        }
        switch (request.type) {
          case "start":
            return BigInt(blot_abi_registry.protocol.phases.start);
          case "step":
            return BigInt(blot_abi_registry.protocol.phases.update);
          case "describe":
            return BigInt(blot_abi_registry.protocol.phases.describe);
          case "render":
            return BigInt(blot_abi_registry.protocol.phases.render);
          case "schema":
            return BigInt(blot_abi_registry.protocol.phases.schema);
        }
      },
    },
    SceneTree: {
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
    State: {
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
    Cells: {
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
      put: ({ index, value }) => {
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
    DataAsset: {
      copy_to_cells: ({ asset, field, first_cell }) => {
        const request = active_invocation;
        if (request?.type !== "start" && request?.type !== "step") {
          throw new Error("Blot copied a data asset outside a state phase");
        }
        const asset_id = schema_integer(asset, "data asset id");
        const field_index = schema_integer(field, "data asset field");
        const cell_offset = schema_integer(first_cell, "data asset first cell");
        const source = integer_data_assets.get(asset_id);
        if (!source) throw new Error(`Blot data asset ${asset_id} is missing`);
        const values = source.fields[field_index];
        if (!values) {
          throw new Error(
            `Blot data asset ${asset_id} field ${field_index} is missing`,
          );
        }
        if (cell_offset < 0 || cell_offset + values.length > 262_144) {
          throw new Error(
            `Blot data asset ${asset_id} field ${field_index} cannot fit at cell ${cell_offset}`,
          );
        }
        while (active_cells.length < cell_offset + values.length) {
          active_cells.push(0n);
        }
        for (const [index, value] of values.entries()) {
          active_cells[cell_offset + index] = BigInt(value);
        }
      },
      get: ({ asset, field, index }) => {
        const asset_id = schema_integer(asset, "data asset id");
        const field_index = schema_integer(field, "data asset field");
        const value_index = schema_integer(index, "data asset value index");
        const source = integer_data_assets.get(asset_id);
        if (!source) throw new Error(`Blot data asset ${asset_id} is missing`);
        const values = source.fields[field_index];
        if (!values) {
          throw new Error(
            `Blot data asset ${asset_id} field ${field_index} is missing`,
          );
        }
        const value = values[value_index];
        if (value === undefined) {
          throw new Error(
            `Blot data asset ${asset_id} field ${field_index} index ${value_index} is outside 0..${
              values.length - 1
            }`,
          );
        }
        return BigInt(value);
      },
      length: ({ asset, field }) => {
        const asset_id = schema_integer(asset, "data asset id");
        const field_index = schema_integer(field, "data asset field");
        const source = integer_data_assets.get(asset_id);
        if (!source) throw new Error(`Blot data asset ${asset_id} is missing`);
        const values = source.fields[field_index];
        if (!values) {
          throw new Error(
            `Blot data asset ${asset_id} field ${field_index} is missing`,
          );
        }
        return BigInt(values.length);
      },
    },
    EcsSchema: {
      world: ({
        base,
        capacity,
        component_base,
        component_capacity,
        component_stride,
        entity_metadata_base,
        entity_mode,
        max_fields,
        resource_base,
        resource_capacity,
        resource_stride,
      }) => {
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
      component: ({ field_count, fields, id, name }) => {
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
          fields,
          id: schema_integer(id, "ECS component id"),
          name,
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
      resource: ({ field_count, fields, id, name, source }) => {
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
          fields,
          id: schema_integer(id, "ECS resource id"),
          name,
          source,
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
      seed_indexed: ({ component, source, world_base }) => {
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
    Viewport: {
      current: () => {
        const request = active_invocation;
        if (request?.type !== "describe" && request?.type !== "render") {
          throw new Error(
            "Blot requested the viewport outside an output phase",
          );
        }
        return {
          height: BigInt(request.viewport.height),
          width: BigInt(request.viewport.width),
        };
      },
    },
    Events: {
      next: () => {
        const request = active_invocation;
        if (request?.type !== "step") {
          throw new Error("Blot requested an event outside a game step");
        }
        return {
          kind: BigInt(request.event_kind),
          target: BigInt(request.target),
          value: BigInt(request.value),
        };
      },
    },
    Time: {
      delta_us: () => {
        const request = active_invocation;
        if (request?.type !== "step") {
          throw new Error("Blot requested delta time outside a game step");
        }
        return BigInt(request.delta_us);
      },
    },
    HostEffect: {
      play_audio: ({ cue, id }) => {
        if (active_invocation?.type !== "step") {
          throw new Error("Blot emitted an audio effect outside an update");
        }
        const effect_id = id.trim();
        if (effect_id.length === 0) {
          throw new Error("Blot audio effect identity cannot be empty");
        }
        if (host_effects.some((effect) => effect.id === effect_id)) {
          throw new Error(
            `Blot emitted audio effect ${
              JSON.stringify(effect_id)
            } more than once`,
          );
        }
        host_effects.push({
          type: "play_audio",
          id: effect_id,
          cue: asset_id<"audio">(cue),
        });
      },
    },
    Ui: {
      action: ({ id, kind, label, target, value }) => {
        actions.push({
          id,
          label: literal_text(label),
          trigger: { type: "command" },
          action: {
            type: "custom",
            kind: Number(kind),
            target: Number(target),
            value: Number(value),
          },
        });
      },
      placement: ({
        id,
        object,
        offset_x,
        offset_y,
        offset_z,
        plane_height,
        plane_width,
      }) => {
        if (ui_placement !== undefined) {
          throw new Error(
            `UI element ${
              JSON.stringify(ui_placement.id)
            } omitted its element operation`,
          );
        }
        if (Number(object) >= 0) {
          ui_placement = {
            id,
            value: {
              type: "scene",
              node: scene_node_id(Number(object), 0),
              offset: vec3(
                Number(offset_x),
                Number(offset_y),
                Number(offset_z),
              ),
              size: vec2(Number(plane_width), Number(plane_height)),
            },
          };
          return;
        }
        let anchor: Extract<
          UiPlacement,
          { type: "viewport" }
        >["anchor"];
        switch (Number(object)) {
          case blot_abi_registry.protocol.ui.viewport_anchors.top_left:
            anchor = "top_left";
            break;
          case blot_abi_registry.protocol.ui.viewport_anchors.top_right:
            anchor = "top_right";
            break;
          case blot_abi_registry.protocol.ui.viewport_anchors.bottom_left:
            anchor = "bottom_left";
            break;
          case blot_abi_registry.protocol.ui.viewport_anchors.bottom_right:
            anchor = "bottom_right";
            break;
          case blot_abi_registry.protocol.ui.viewport_anchors.center:
            anchor = "center";
            break;
          default:
            throw new Error(
              `semantic viewport anchor ${object} is not supported`,
            );
        }
        ui_placement = {
          id,
          value: {
            type: "viewport",
            anchor,
            inset: vec2(Number(offset_x), Number(offset_y)),
            size: vec2(0, 0),
          },
        };
      },
      element: ({
        description,
        element_height,
        element_width,
        id,
        kind,
        label,
        maximum,
        order,
        pressed,
        selected,
        target,
        value,
      }) => {
        if (ui_placement?.id !== id) {
          throw new Error(
            `UI element ${JSON.stringify(id)} has no matching placement`,
          );
        }
        const element_id = ui_id(id);
        const element_width_value = Number(element_width);
        const element_height_value = Number(element_height);
        const placement = ui_placement.value.type === "viewport"
          ? {
            ...ui_placement.value,
            size: vec2(element_width_value, element_height_value),
          }
          : ui_placement.value;
        const common_node = {
          id: element_id,
          label: literal_text(label),
          ...(description.length === 0
            ? {}
            : { description: literal_text(description) }),
          size: {
            width: element_width_value,
            height: element_height_value,
          },
          placement,
          reading_order: Number(order),
          focus_order: Number(order),
        } as const;
        ui_placement = undefined;
        if (kind === BigInt(blot_abi_registry.protocol.ui.roles.button)) {
          const focus: ActionDescription = {
            id: `focus:${id}`,
            label: literal_text(`Focus ${id}`),
            trigger: { type: "focus", target: element_id },
            action: { type: "focus", target: Number(target) },
          };
          const activate: ActionDescription = {
            id: `activate:${id}`,
            label: literal_text(`Activate ${id}`),
            trigger: { type: "activate", target: element_id },
            action: { type: "activate", target: Number(target) },
          };
          actions.push(focus, activate);
          ui_nodes.push({
            ...common_node,
            role: "button",
            pressed,
            selected,
            actions: [focus, activate],
          });
          return;
        }
        if (kind === BigInt(blot_abi_registry.protocol.ui.roles.text)) {
          ui_nodes.push({ ...common_node, role: "text" });
          return;
        }
        if (kind === BigInt(blot_abi_registry.protocol.ui.roles.progress)) {
          ui_nodes.push({
            ...common_node,
            role: "progress",
            minimum: 0,
            maximum: Number(maximum),
            value: Number(value),
          });
          return;
        }
        throw new Error(
          `UI element ${JSON.stringify(id)} has unsupported kind ${kind}`,
        );
      },
      status: ({ done, label, value }) => {
        status = {
          done,
          label,
          value,
        };
      },
    },
    Render: {
      directional_light: ({
        color_blue,
        color_green,
        color_red,
        direction_x,
        direction_y,
        direction_z,
        intensity,
      }) => {
        if (directional_light !== undefined) {
          throw new Error("Blot rendered more than one directional light");
        }
        const normalized_color = fixed_point_vector(
          color_red,
          color_green,
          color_blue,
          "directional light color",
        );
        const color_channels: readonly (readonly [string, number])[] = [
          ["red", normalized_color[0]],
          ["green", normalized_color[1]],
          ["blue", normalized_color[2]],
        ];
        for (const [channel, value] of color_channels) {
          if (value < 0 || value > 1) {
            throw new Error(
              `Blot directional light color ${channel} ${value} must be between 0 and 1`,
            );
          }
        }
        const normalized_direction = fixed_point_vector(
          direction_x,
          direction_y,
          direction_z,
          "directional light direction",
        );
        if (Math.hypot(...normalized_direction) === 0) {
          throw new Error(
            `Blot directional light direction ${
              JSON.stringify(normalized_direction)
            } must not be zero`,
          );
        }
        const normalized_intensity = fixed_point_number(
          intensity,
          "directional light intensity",
        );
        if (normalized_intensity <= 0) {
          throw new Error(
            `Blot directional light intensity ${normalized_intensity} must be positive`,
          );
        }
        directional_light = {
          type: "directional_light",
          color: normalized_color,
          direction: normalized_direction,
          intensity: normalized_intensity,
        };
      },
      environment: ({
        ambient_blue,
        ambient_green,
        ambient_red,
        bloom_intensity,
        exposure_ev100,
        fog_blue,
        fog_density,
        fog_green,
        fog_red,
      }) => {
        if (environment !== undefined) {
          throw new Error("Blot rendered more than one environment");
        }
        const normalized_fog_density = fixed_point_number(
          fog_density,
          "environment fog density",
        );
        const normalized_bloom_intensity = fixed_point_number(
          bloom_intensity,
          "environment bloom intensity",
        );
        if (normalized_fog_density < 0) {
          throw new Error(
            `Blot environment fog density ${normalized_fog_density} must not be negative`,
          );
        }
        if (normalized_bloom_intensity < 0) {
          throw new Error(
            `Blot environment bloom intensity ${normalized_bloom_intensity} must not be negative`,
          );
        }
        environment = {
          ambient_light: fixed_point_vector(
            ambient_red,
            ambient_green,
            ambient_blue,
            "environment ambient light",
          ),
          fog_color: fixed_point_vector(
            fog_red,
            fog_green,
            fog_blue,
            "environment fog color",
          ),
          fog_density: normalized_fog_density,
          exposure_ev100: fixed_point_number(
            exposure_ev100,
            "environment exposure EV100",
          ),
          bloom_intensity: normalized_bloom_intensity,
        };
      },
      orthogonal_tilemap: ({
        atlas_columns,
        cell_offset,
        columns,
        first_object_id,
        mesh,
        origin_x,
        origin_y,
        rows,
        texture,
        tile_size,
        z,
      }) => {
        const column_count = schema_integer(
          columns,
          "orthogonal tilemap columns",
        );
        const row_count = schema_integer(rows, "orthogonal tilemap rows");
        const atlas_width = schema_integer(
          atlas_columns,
          "orthogonal tilemap atlas columns",
        );
        const cells_start = schema_integer(
          cell_offset,
          "orthogonal tilemap cell offset",
        );
        const object_start = schema_integer(
          first_object_id,
          "orthogonal tilemap first object id",
        );
        const mesh_id = schema_integer(mesh, "orthogonal tilemap mesh");
        const texture_id = schema_integer(
          texture,
          "orthogonal tilemap texture",
        );
        const world_tile_size = schema_integer(
          tile_size,
          "orthogonal tilemap tile size",
        );
        const tile_count = column_count * row_count;
        if (
          column_count <= 0 || row_count <= 0 || atlas_width <= 0 ||
          world_tile_size <= 0 || cells_start < 0 || object_start < 0 ||
          mesh_id < 0 || texture_id < 0 || !Number.isSafeInteger(tile_count) ||
          tile_count > 262_144
        ) {
          throw new Error(
            `invalid orthogonal tilemap dimensions ${column_count}x${row_count}, atlas ${atlas_width}, tile size ${world_tile_size}`,
          );
        }
        const atlas_tile_size = 1 / atlas_width;
        const tile_objects: SceneObjectCommand[] = [];
        for (let index = 0; index < tile_count; index += 1) {
          const tile = Number(active_cells[cells_start + index] ?? -1n);
          const column = index % column_count;
          const row = Math.floor(index / column_count);
          tile_objects.push({
            type: "scene_object",
            id: object_start + index,
            mesh: mesh_id,
            parent: null,
            color: [1, 1, 1],
            emissive: 1,
            texture: texture_id,
            texture_offset: tile < 0 ? [0, 0] : [
              (tile % atlas_width) * atlas_tile_size,
              Math.floor(tile / atlas_width) * atlas_tile_size,
            ],
            secondary_texture: null,
            texture_scale: [atlas_tile_size, atlas_tile_size],
            blend_edges: 0,
            variation_seed: 0,
            surface_mode: 4,
            path_connections: 0,
            rotation_radians: [0, 0, 0],
            position: [
              Number(origin_x) + column * world_tile_size,
              Number(origin_y) - row * world_tile_size,
              Number(z),
            ],
            scale: [world_tile_size, world_tile_size, 100_000],
            visible: tile >= 0,
          });
        }
        objects = [...objects, ...tile_objects];
      },
      mesh: ({ id, mesh }) => {
        object_meshes.set(Number(id), Number(mesh));
      },
      node: ({
        id,
        parent,
        rotation_x_microradians,
        rotation_y_microradians,
        rotation_z_microradians,
        scale_x,
        scale_y,
        scale_z,
        visible,
        x,
        y,
        z,
      }) => {
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
          visible,
        });
      },
      material: ({
        blend_edges,
        color_blue,
        color_green,
        color_red,
        id,
        path_connections,
        secondary_texture,
        surface_mode,
        texture,
        texture_offset_x,
        texture_offset_y,
        texture_scale_x,
        texture_scale_y,
        variation_seed,
      }) => {
        if (surface_mode < 0n || surface_mode > 4n) {
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
          texture_offset: [
            Number(texture_offset_x) / 1_000_000,
            Number(texture_offset_y) / 1_000_000,
          ],
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
      object: ({
        emissive,
        id,
        parent,
        rotation_x_microradians,
        rotation_y_microradians,
        rotation_z_microradians,
        scale_x,
        scale_y,
        scale_z,
        visible,
        x,
        y,
        z,
      }) => {
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
          texture_offset: material.texture_offset,
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
          visible,
        }];
      },
      orthographic_camera: ({
        clear_blue,
        clear_green,
        clear_red,
        position_x,
        position_y,
        position_z,
        target_x,
        target_y,
        target_z,
        vertical_size,
      }) => {
        if (camera !== undefined) {
          throw new Error("Blot rendered more than one camera");
        }
        const normalized_vertical_size = fixed_point_number(
          vertical_size,
          "orthographic camera vertical size",
        );
        if (normalized_vertical_size <= 0) {
          throw new Error(
            `Blot orthographic camera vertical size ${normalized_vertical_size} must be positive`,
          );
        }
        const normalized_position = fixed_point_vector(
          position_x,
          position_y,
          position_z,
          "orthographic camera position",
        );
        const normalized_target = fixed_point_vector(
          target_x,
          target_y,
          target_z,
          "orthographic camera target",
        );
        if (
          normalized_position[0] === normalized_target[0] &&
          normalized_position[1] === normalized_target[1] &&
          normalized_position[2] === normalized_target[2]
        ) {
          throw new Error(
            `Blot orthographic camera position ${
              JSON.stringify(normalized_position)
            } must differ from target ${JSON.stringify(normalized_target)}`,
          );
        }
        camera = {
          type: "orthographic",
          position: normalized_position,
          target: normalized_target,
          clear_color: fixed_point_vector(
            clear_red,
            clear_green,
            clear_blue,
            "orthographic camera clear color",
          ),
          vertical_size: normalized_vertical_size,
        };
      },
      perspective_camera: ({
        clear_blue,
        clear_green,
        clear_red,
        position_x,
        position_y,
        position_z,
        target_x,
        target_y,
        target_z,
        vertical_fov_microradians,
      }) => {
        if (camera !== undefined) {
          throw new Error("Blot rendered more than one camera");
        }
        const vertical_fov_radians = fixed_point_number(
          vertical_fov_microradians,
          "perspective camera vertical field of view",
        );
        if (vertical_fov_radians <= 0 || vertical_fov_radians >= Math.PI) {
          throw new Error(
            `Blot perspective camera vertical field of view ${vertical_fov_radians} must be between 0 and pi radians`,
          );
        }
        const normalized_position = fixed_point_vector(
          position_x,
          position_y,
          position_z,
          "perspective camera position",
        );
        const normalized_target = fixed_point_vector(
          target_x,
          target_y,
          target_z,
          "perspective camera target",
        );
        if (
          normalized_position[0] === normalized_target[0] &&
          normalized_position[1] === normalized_target[1] &&
          normalized_position[2] === normalized_target[2]
        ) {
          throw new Error(
            `Blot perspective camera position ${
              JSON.stringify(normalized_position)
            } must differ from target ${JSON.stringify(normalized_target)}`,
          );
        }
        camera = {
          type: "perspective",
          position: normalized_position,
          target: normalized_target,
          clear_color: fixed_point_vector(
            clear_red,
            clear_green,
            clear_blue,
            "perspective camera clear color",
          ),
          vertical_fov_radians,
        };
      },
    },
  } satisfies BlotHostImportImplementations;

  const module = await WebAssembly.compile(new Uint8Array(wasm_bytes).buffer);
  require_blot_module_imports(module, manifest.imports);
  const host_import_modules = create_blot_host_import_modules(imports, {
    memory: () => {
      const memory = memory_reference.current;
      if (memory === undefined) {
        throw new Error("Blot guest memory is unavailable");
      }
      return memory;
    },
    resolve_runtime_reference: (reference) => runtime_references.get(reference),
  });
  const module_imports = {
    __gpupaper_runtime: gpupaper_runtime,
    ...host_import_modules,
  };
  const instantiated = instantiation === undefined
    ? await WebAssembly.instantiate(module, module_imports)
    : await instantiation.instantiate(module, module_imports);
  const guest = parse_blot_guest_exports(instantiated.exports);
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
      guest.entrypoint();
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
      host_effects = [];
      const next_state = run_state_phase({
        type: "step",
        state,
        event_kind,
        target,
        value,
        delta_us,
      });
      return {
        state: next_state,
        effects: Object.freeze([...host_effects]),
      };
    },
    describe(state, viewport, revision) {
      actions = [];
      ui_nodes = [];
      ui_placement = undefined;
      status = undefined;
      const unexpected_state = run_phase({
        type: "describe",
        state,
        viewport,
      });
      if (unexpected_state !== undefined) {
        throw new Error("Blot description unexpectedly committed game state");
      }
      const captured_status = require_game_status(status);
      require_complete_ui_element(ui_placement);
      const action_ids = new Set<string>();
      for (const action of actions) {
        if (action_ids.has(action.id)) {
          throw new Error(
            `Blot UI repeats action ${JSON.stringify(action.id)}`,
          );
        }
        action_ids.add(action.id);
      }
      const ui_result = new UiSnapshotStore().replace({
        revision,
        direction: "auto",
        root: {
          id: ui_id("blot.game"),
          role: "region",
          label: literal_text(captured_status.label),
          description: literal_text(captured_status.value),
          placement: {
            type: "absolute",
            x: 0,
            y: 0,
            width: viewport.width,
            height: viewport.height,
          },
          layout: { type: "absolute" },
          actions: actions.filter(({ trigger }) => trigger.type === "command"),
          children: ui_nodes.toSorted((left, right) =>
            (left.reading_order ?? 0) - (right.reading_order ?? 0) ||
            left.id.localeCompare(right.id)
          ),
        },
        announcements: [],
      });
      if (ui_result.type === "rejected") {
        throw new Error(
          `Blot emitted invalid canonical UI: ${ui_result.reason}`,
        );
      }
      return {
        actions: Object.freeze([...actions]),
        ui: ui_result.snapshot,
        status: captured_status,
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
      camera = undefined;
      directional_light = undefined;
      environment = undefined;
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
      if (camera === undefined) {
        throw new Error("Blot render did not emit a camera");
      }
      if (directional_light === undefined) {
        throw new Error("Blot render did not emit a directional light");
      }
      if (environment === undefined) {
        throw new Error("Blot render did not emit an environment");
      }
      return {
        camera,
        directional_light,
        environment,
        nodes,
        objects,
        resources,
      };
    },
  };
}

function require_game_status(status: GameStatus | undefined): GameStatus {
  if (status === undefined) {
    throw new Error("Blot describe did not emit a game status");
  }
  return status;
}

function require_complete_ui_element(
  placement: { readonly id: string } | undefined,
): void {
  if (placement === undefined) return;
  throw new Error(
    `UI element ${JSON.stringify(placement.id)} omitted its element operation`,
  );
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
