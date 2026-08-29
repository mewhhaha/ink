import { editor_preset_id } from "@ink/authoring/identity.ts";
import {
  platformer_connection_id,
  platformer_layer_id,
  platformer_level_id,
  platformer_project_id,
  platformer_record_id,
} from "./identity.ts";
import {
  platformer_project,
  type PlatformerAction,
  type PlatformerBounds,
  type PlatformerCamera,
  type PlatformerCondition,
  type PlatformerLayer,
  type PlatformerLevel,
  type PlatformerLogicConnection,
  type PlatformerMovement,
  type PlatformerPoint,
  type PlatformerProject,
  type PlatformerRecord,
  type PlatformerTrigger,
} from "./model.ts";
import { platformer_preset } from "./presets.ts";
import { validate_platformer_project } from "./validation.ts";

export function parse_platformer_project(
  source: string,
  source_name = "platformer project",
): PlatformerProject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    throw new Error(`${source_name} is not valid JSON`, { cause });
  }
  const root = exact_record(parsed, [
    "camera",
    "default_mechanics",
    "entry_level_id",
    "id",
    "levels",
    "movement",
    "name",
    "preset_id",
    "schema_version",
  ], source_name);
  if (root.schema_version !== 1) {
    throw new Error(
      `${source_name} schema version ${
        JSON.stringify(root.schema_version)
      } is unsupported`,
    );
  }
  const preset = platformer_preset(
    text(root.preset_id, `${source_name} preset_id`),
  );
  const project = platformer_project({
    schema_version: 1,
    id: platformer_project_id(text(root.id, `${source_name} id`)),
    name: text(root.name, `${source_name} name`),
    preset_id: editor_preset_id(preset.id),
    movement: parse_movement(root.movement, `${source_name} movement`),
    camera: parse_camera(root.camera, `${source_name} camera`),
    default_mechanics: string_array(
      root.default_mechanics,
      `${source_name} default_mechanics`,
    ),
    entry_level_id: platformer_level_id(
      text(root.entry_level_id, `${source_name} entry_level_id`),
    ),
    levels: array(root.levels, `${source_name} levels`).map((entry, index) =>
      parse_level(entry, `${source_name} levels[${index}]`)
    ),
  });
  const errors = validate_platformer_project(project).filter(({ severity }) =>
    severity === "error"
  );
  if (errors.length > 0) {
    throw new Error(
      `${source_name} is invalid: ${
        errors.map(({ message }) => message).join("; ")
      }`,
    );
  }
  return project;
}

export function serialize_platformer_project(
  project: PlatformerProject,
): string {
  return `${JSON.stringify(canonical(project), null, 2)}\n`;
}

function parse_movement(value: unknown, label: string): PlatformerMovement {
  const movement = exact_record(value, [
    "air_acceleration",
    "available_jumps",
    "coyote_time_seconds",
    "dash",
    "gravity",
    "ground_acceleration",
    "jump_buffer_seconds",
    "jump_speed",
    "maximum_run_speed",
    "terminal_fall_speed",
    "variable_jump",
    "wall_jump",
  ], label);
  const available_jumps = finite_number(
    movement.available_jumps,
    `${label} available_jumps`,
  );
  if (available_jumps !== 1 && available_jumps !== 2) {
    throw new Error(`${label} available_jumps must be 1 or 2`);
  }
  return {
    maximum_run_speed: finite_number(
      movement.maximum_run_speed,
      `${label} maximum_run_speed`,
    ),
    ground_acceleration: finite_number(
      movement.ground_acceleration,
      `${label} ground_acceleration`,
    ),
    air_acceleration: finite_number(
      movement.air_acceleration,
      `${label} air_acceleration`,
    ),
    jump_speed: finite_number(movement.jump_speed, `${label} jump_speed`),
    gravity: finite_number(movement.gravity, `${label} gravity`),
    terminal_fall_speed: finite_number(
      movement.terminal_fall_speed,
      `${label} terminal_fall_speed`,
    ),
    coyote_time_seconds: finite_number(
      movement.coyote_time_seconds,
      `${label} coyote_time_seconds`,
    ),
    jump_buffer_seconds: finite_number(
      movement.jump_buffer_seconds,
      `${label} jump_buffer_seconds`,
    ),
    available_jumps,
    variable_jump: boolean_value(
      movement.variable_jump,
      `${label} variable_jump`,
    ),
    wall_jump: boolean_value(movement.wall_jump, `${label} wall_jump`),
    dash: boolean_value(movement.dash, `${label} dash`),
  };
}

function parse_camera(value: unknown, label: string): PlatformerCamera {
  const camera = exact_record(value, [
    "dead_zone_height",
    "dead_zone_width",
    "look_ahead",
    "mode",
    "smoothing",
    "vertical_tracking",
  ], label);
  return {
    mode: one_of(
      camera.mode,
      ["follow", "forward_focus", "room", "cinematic"],
      `${label} mode`,
    ),
    smoothing: finite_number(camera.smoothing, `${label} smoothing`),
    look_ahead: finite_number(camera.look_ahead, `${label} look_ahead`),
    dead_zone_width: finite_number(
      camera.dead_zone_width,
      `${label} dead_zone_width`,
    ),
    dead_zone_height: finite_number(
      camera.dead_zone_height,
      `${label} dead_zone_height`,
    ),
    vertical_tracking: finite_number(
      camera.vertical_tracking,
      `${label} vertical_tracking`,
    ),
  };
}

function parse_level(value: unknown, label: string): PlatformerLevel {
  const level = exact_record(value, [
    "bounds",
    "connections",
    "id",
    "kill_plane_y",
    "layers",
    "name",
  ], label);
  return {
    id: platformer_level_id(text(level.id, `${label} id`)),
    name: text(level.name, `${label} name`),
    bounds: parse_bounds(level.bounds, `${label} bounds`),
    kill_plane_y: finite_number(level.kill_plane_y, `${label} kill_plane_y`),
    layers: array(level.layers, `${label} layers`).map((entry, index) =>
      parse_layer(entry, `${label} layers[${index}]`)
    ),
    connections: array(level.connections, `${label} connections`).map(
      (entry, index) =>
        parse_connection(entry, `${label} connections[${index}]`),
    ),
  };
}

function parse_layer(value: unknown, label: string): PlatformerLayer {
  const layer = exact_record(
    value,
    ["depth", "id", "kind", "name", "records"],
    label,
  );
  return {
    id: platformer_layer_id(text(layer.id, `${label} id`)),
    name: text(layer.name, `${label} name`),
    kind: one_of(layer.kind, [
      "collision",
      "gameplay",
      "logic",
      "camera",
      "decoration",
    ], `${label} kind`),
    depth: finite_number(layer.depth, `${label} depth`),
    records: array(layer.records, `${label} records`).map((entry, index) =>
      parse_record(entry, `${label} records[${index}]`)
    ),
  };
}

function parse_record(value: unknown, label: string): PlatformerRecord {
  const record = record_value(value, label);
  const kind = text(record.kind, `${label} kind`);
  const common = {
    id: platformer_record_id(text(record.id, `${label} id`)),
    name: text(record.name, `${label} name`),
  };
  switch (kind) {
    case "platform":
      expect_fields(record, [
        "bounds",
        "friction",
        "id",
        "kind",
        "name",
        "surface",
      ], label);
      return {
        ...common,
        kind,
        bounds: parse_bounds(record.bounds, `${label} bounds`),
        surface: one_of(
          record.surface,
          ["solid", "one_way"],
          `${label} surface`,
        ),
        friction: finite_number(record.friction, `${label} friction`),
      };
    case "slope":
      expect_fields(
        record,
        ["end", "id", "kind", "name", "start", "surface"],
        label,
      );
      return {
        ...common,
        kind,
        start: parse_point(record.start, `${label} start`),
        end: parse_point(record.end, `${label} end`),
        surface: one_of(
          record.surface,
          ["solid", "one_way"],
          `${label} surface`,
        ),
      };
    case "hazard":
      expect_fields(record, ["bounds", "effect", "id", "kind", "name"], label);
      return {
        ...common,
        kind,
        bounds: parse_bounds(record.bounds, `${label} bounds`),
        effect: parse_hazard_effect(record.effect, `${label} effect`),
      };
    case "spawn":
      expect_fields(
        record,
        ["facing", "id", "kind", "name", "position"],
        label,
      );
      return {
        ...common,
        kind,
        position: parse_point(record.position, `${label} position`),
        facing: one_of(record.facing, ["left", "right"], `${label} facing`),
      };
    case "checkpoint":
      expect_fields(record, [
        "bounds",
        "id",
        "kind",
        "name",
        "respawn_position",
      ], label);
      return {
        ...common,
        kind,
        bounds: parse_bounds(record.bounds, `${label} bounds`),
        respawn_position: parse_point(
          record.respawn_position,
          `${label} respawn_position`,
        ),
      };
    case "exit":
      expect_fields(
        record,
        ["bounds", "destination", "id", "kind", "name"],
        label,
      );
      return {
        ...common,
        kind,
        bounds: parse_bounds(record.bounds, `${label} bounds`),
        destination: parse_exit_destination(
          record.destination,
          `${label} destination`,
        ),
      };
    case "collectible":
      expect_fields(record, [
        "collectible_key",
        "id",
        "kind",
        "name",
        "position",
        "quantity",
      ], label);
      return {
        ...common,
        kind,
        position: parse_point(record.position, `${label} position`),
        collectible_key: text(
          record.collectible_key,
          `${label} collectible_key`,
        ),
        quantity: finite_number(record.quantity, `${label} quantity`),
      };
    case "enemy":
      expect_optional_fields(
        record,
        ["archetype", "id", "kind", "name", "position"],
        ["patrol_bounds"],
        label,
      );
      return {
        ...common,
        kind,
        position: parse_point(record.position, `${label} position`),
        archetype: text(record.archetype, `${label} archetype`),
        ...(record.patrol_bounds === undefined ? {} : {
          patrol_bounds: parse_bounds(
            record.patrol_bounds,
            `${label} patrol_bounds`,
          ),
        }),
      };
    case "moving_path":
      expect_fields(record, [
        "id",
        "kind",
        "name",
        "platform_id",
        "points",
        "speed",
        "traversal",
      ], label);
      return {
        ...common,
        kind,
        platform_id: platformer_record_id(
          text(record.platform_id, `${label} platform_id`),
        ),
        points: array(record.points, `${label} points`).map((entry, index) =>
          parse_point(entry, `${label} points[${index}]`)
        ),
        speed: finite_number(record.speed, `${label} speed`),
        traversal: one_of(
          record.traversal,
          ["cycle", "ping_pong"],
          `${label} traversal`,
        ),
      };
    case "trigger_zone":
      expect_fields(
        record,
        ["activation", "bounds", "id", "kind", "name"],
        label,
      );
      return {
        ...common,
        kind,
        bounds: parse_bounds(record.bounds, `${label} bounds`),
        activation: one_of(
          record.activation,
          ["once", "repeat"],
          `${label} activation`,
        ),
      };
    case "camera_zone":
      expect_fields(record, [
        "bounds",
        "camera",
        "id",
        "kind",
        "name",
        "priority",
      ], label);
      return {
        ...common,
        kind,
        bounds: parse_bounds(record.bounds, `${label} bounds`),
        camera: parse_camera(record.camera, `${label} camera`),
        priority: finite_number(record.priority, `${label} priority`),
      };
    default:
      throw new Error(`${label} kind ${JSON.stringify(kind)} is unsupported`);
  }
}

function parse_hazard_effect(
  value: unknown,
  label: string,
): Extract<PlatformerRecord, { readonly kind: "hazard" }>["effect"] {
  const effect = record_value(value, label);
  if (effect.type === "defeat") {
    expect_fields(effect, ["type"], label);
    return { type: "defeat" };
  }
  if (effect.type === "damage") {
    expect_fields(effect, ["amount", "type"], label);
    return {
      type: "damage",
      amount: finite_number(effect.amount, `${label} amount`),
    };
  }
  throw new Error(
    `${label} type ${JSON.stringify(effect.type)} is unsupported`,
  );
}

function parse_exit_destination(
  value: unknown,
  label: string,
): Extract<PlatformerRecord, { readonly kind: "exit" }>["destination"] {
  const destination = record_value(value, label);
  if (destination.type === "complete") {
    expect_fields(destination, ["type"], label);
    return { type: "complete" };
  }
  if (destination.type === "level") {
    expect_fields(destination, ["level_id", "type"], label);
    return {
      type: "level",
      level_id: platformer_level_id(
        text(destination.level_id, `${label} level_id`),
      ),
    };
  }
  throw new Error(
    `${label} type ${JSON.stringify(destination.type)} is unsupported`,
  );
}

function parse_connection(
  value: unknown,
  label: string,
): PlatformerLogicConnection {
  const connection = exact_record(value, [
    "action",
    "condition",
    "id",
    "trigger",
  ], label);
  return {
    id: platformer_connection_id(text(connection.id, `${label} id`)),
    trigger: parse_trigger(connection.trigger, `${label} trigger`),
    condition: parse_condition(connection.condition, `${label} condition`),
    action: parse_action(connection.action, `${label} action`),
  };
}

function parse_trigger(value: unknown, label: string): PlatformerTrigger {
  const trigger = exact_record(value, ["event", "record_id"], label);
  return {
    record_id: platformer_record_id(
      text(trigger.record_id, `${label} record_id`),
    ),
    event: one_of(trigger.event, [
      "entered",
      "left",
      "collected",
      "defeated",
      "activated",
      "reached",
    ], `${label} event`),
  };
}

function parse_condition(value: unknown, label: string): PlatformerCondition {
  const condition = record_value(value, label);
  if (condition.type === "always") {
    expect_fields(condition, ["type"], label);
    return { type: "always" };
  }
  if (condition.type === "collectible_collected") {
    expect_fields(condition, ["collectible_id", "type"], label);
    return {
      type: condition.type,
      collectible_id: platformer_record_id(
        text(condition.collectible_id, `${label} collectible_id`),
      ),
    };
  }
  if (condition.type === "enemy_defeated") {
    expect_fields(condition, ["enemy_id", "type"], label);
    return {
      type: condition.type,
      enemy_id: platformer_record_id(
        text(condition.enemy_id, `${label} enemy_id`),
      ),
    };
  }
  if (condition.type === "checkpoint_reached") {
    expect_fields(condition, ["checkpoint_id", "type"], label);
    return {
      type: condition.type,
      checkpoint_id: platformer_record_id(
        text(condition.checkpoint_id, `${label} checkpoint_id`),
      ),
    };
  }
  throw new Error(
    `${label} type ${JSON.stringify(condition.type)} is unsupported`,
  );
}

function parse_action(value: unknown, label: string): PlatformerAction {
  const action = record_value(value, label);
  const type = text(action.type, `${label} type`);
  if (type === "enable_record" || type === "disable_record") {
    expect_fields(action, ["record_id", "type"], label);
    return {
      type,
      record_id: platformer_record_id(
        text(action.record_id, `${label} record_id`),
      ),
    };
  }
  if (type === "start_moving_path") {
    expect_fields(action, ["path_id", "type"], label);
    return {
      type,
      path_id: platformer_record_id(text(action.path_id, `${label} path_id`)),
    };
  }
  if (type === "activate_checkpoint") {
    expect_fields(action, ["checkpoint_id", "type"], label);
    return {
      type,
      checkpoint_id: platformer_record_id(
        text(action.checkpoint_id, `${label} checkpoint_id`),
      ),
    };
  }
  if (type === "load_level") {
    expect_fields(action, ["level_id", "type"], label);
    return {
      type,
      level_id: platformer_level_id(text(action.level_id, `${label} level_id`)),
    };
  }
  if (type === "complete_level") {
    expect_fields(action, ["type"], label);
    return { type };
  }
  throw new Error(`${label} type ${JSON.stringify(type)} is unsupported`);
}

function parse_bounds(value: unknown, label: string): PlatformerBounds {
  const bounds = exact_record(value, ["maximum", "minimum"], label);
  return {
    minimum: parse_point(bounds.minimum, `${label} minimum`),
    maximum: parse_point(bounds.maximum, `${label} maximum`),
  };
}

function parse_point(value: unknown, label: string): PlatformerPoint {
  const point = exact_record(value, ["x", "y"], label);
  return {
    x: finite_number(point.x, `${label} x`),
    y: finite_number(point.y, `${label} y`),
  };
}

function exact_record(
  value: unknown,
  fields: readonly string[],
  label: string,
): Record<string, unknown> {
  const parsed = record_value(value, label);
  expect_fields(parsed, fields, label);
  return parsed;
}

function record_value(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expect_fields(
  value: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.join("\n") === expected.join("\n")) return;
  throw new Error(
    `${label} fields are ${JSON.stringify(actual)}; expected ${
      JSON.stringify(expected)
    }`,
  );
}

function expect_optional_fields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const missing = required.filter((field) => !(field in value));
  const allowed = new Set([...required, ...optional]);
  const unexpected = Object.keys(value).filter((field) => !allowed.has(field));
  if (missing.length === 0 && unexpected.length === 0) return;
  throw new Error(
    `${label} is missing ${
      JSON.stringify(missing)
    } and has unsupported fields ${JSON.stringify(unexpected.sort())}`,
  );
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function string_array(value: unknown, label: string): readonly string[] {
  return array(value, label).map((entry, index) =>
    text(entry, `${label}[${index}]`)
  );
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} ${JSON.stringify(value)} must be nonempty text`);
  }
  return value.trim();
}

function finite_number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} ${JSON.stringify(value)} must be finite`);
  }
  return value;
}

function boolean_value(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} ${JSON.stringify(value)} must be boolean`);
  }
  return value;
}

function one_of<const Choice extends string>(
  value: unknown,
  choices: readonly Choice[],
  label: string,
): Choice {
  if (typeof value === "string" && choices.includes(value as Choice)) {
    return value as Choice;
  }
  throw new Error(
    `${label} ${JSON.stringify(value)} must be one of ${choices.join(", ")}`,
  );
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonical(nested)]),
  );
}
