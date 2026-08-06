import {
  authoring_diagnostic,
  type AuthoringDiagnostic,
} from "@ink/authoring/diagnostics.ts";
import type {
  PlatformerAction,
  PlatformerBounds,
  PlatformerCondition,
  PlatformerLevel,
  PlatformerLogicConnection,
  PlatformerPoint,
  PlatformerProject,
  PlatformerRecord,
  PlatformerTriggerEvent,
} from "./model.ts";

export function validate_platformer_project(
  project: PlatformerProject,
): readonly AuthoringDiagnostic[] {
  const diagnostics: AuthoringDiagnostic[] = [];
  const level_ids = new Set<string>();
  for (const level of project.levels) {
    if (level_ids.has(level.id)) {
      report(
        diagnostics,
        "DUPLICATE_LEVEL",
        "error",
        `Project ${project.id} contains level ${level.id} more than once.`,
        `level:${level.id}`,
        "Give every level a unique identity.",
      );
    }
    level_ids.add(level.id);
  }
  if (!level_ids.has(project.entry_level_id)) {
    report(
      diagnostics,
      "MISSING_ENTRY_LEVEL",
      "error",
      `Project ${project.id} entry level ${project.entry_level_id} does not exist.`,
      `project:${project.id}`,
      "Choose an existing level as the entry level.",
    );
  }
  validate_movement(project, diagnostics);
  for (const level of project.levels) {
    validate_level(level, level_ids, diagnostics);
  }
  return Object.freeze(diagnostics);
}

function validate_level(
  level: PlatformerLevel,
  level_ids: ReadonlySet<string>,
  diagnostics: AuthoringDiagnostic[],
): void {
  if (!valid_bounds(level.bounds)) {
    report(
      diagnostics,
      "INVALID_LEVEL_BOUNDS",
      "error",
      `Level ${level.id} bounds must have a maximum greater than its minimum on both axes.`,
      `level:${level.id}`,
      "Resize the level so it has positive width and height.",
    );
  }
  if (level.kill_plane_y >= level.bounds.minimum.y) {
    report(
      diagnostics,
      "INVALID_KILL_PLANE",
      "error",
      `Level ${level.id} kill plane ${level.kill_plane_y} must be below its lower bound ${level.bounds.minimum.y}.`,
      `level:${level.id}`,
      "Move the kill plane below the authored level bounds.",
    );
  }

  const layer_ids = new Set<string>();
  const record_by_id = new Map<string, PlatformerRecord>();
  const records: PlatformerRecord[] = [];
  for (const layer of level.layers) {
    if (layer_ids.has(layer.id)) {
      report(
        diagnostics,
        "DUPLICATE_LAYER",
        "error",
        `Level ${level.id} contains layer ${layer.id} more than once.`,
        `layer:${layer.id}`,
        "Give every layer in the level a unique identity.",
      );
    }
    layer_ids.add(layer.id);
    for (const record of layer.records) {
      records.push(record);
      if (record_by_id.has(record.id)) {
        report(
          diagnostics,
          "DUPLICATE_RECORD",
          "error",
          `Level ${level.id} contains record ${record.id} more than once.`,
          `record:${record.id}`,
          "Give every record in the level a unique identity.",
        );
      } else {
        record_by_id.set(record.id, record);
      }
      validate_record(level, record, diagnostics);
    }
  }

  validate_exact_count(level, records, "spawn", diagnostics);
  validate_exact_count(level, records, "exit", diagnostics);
  for (const record of records) {
    if (record.kind === "moving_path") {
      validate_moving_path(level, record, record_by_id, diagnostics);
    }
    if (
      record.kind === "exit" && record.destination.type === "level" &&
      !level_ids.has(record.destination.level_id)
    ) {
      report(
        diagnostics,
        "ORPHAN_EXIT_DESTINATION",
        "error",
        `Exit ${record.id} points to missing level ${record.destination.level_id}.`,
        `record:${record.id}`,
        "Choose an existing destination level or complete the project from this exit.",
      );
    }
  }
  validate_connections(level, record_by_id, level_ids, diagnostics);
}

function validate_exact_count(
  level: PlatformerLevel,
  records: readonly PlatformerRecord[],
  kind: "spawn" | "exit",
  diagnostics: AuthoringDiagnostic[],
): void {
  const count = records.filter((record) => record.kind === kind).length;
  if (count === 1) return;
  const noun = kind === "spawn" ? "player spawn" : "exit";
  const code = kind === "spawn" ? "INVALID_SPAWN_COUNT" : "INVALID_EXIT_COUNT";
  report(
    diagnostics,
    code,
    "error",
    `Level ${level.id} has ${count} ${noun}${
      count === 1 ? "" : "s"
    }; exactly one is required.`,
    `level:${level.id}`,
    `Keep exactly one ${noun} in this level.`,
  );
}

function validate_record(
  level: PlatformerLevel,
  record: PlatformerRecord,
  diagnostics: AuthoringDiagnostic[],
): void {
  for (const [label, bounds] of record_bounds(record)) {
    if (!valid_bounds(bounds)) {
      report(
        diagnostics,
        "INVALID_RECORD_BOUNDS",
        "error",
        `${record.kind} ${record.id} ${label} must have a maximum greater than its minimum.`,
        `record:${record.id}`,
        "Resize the record so it has positive width and height.",
      );
    } else if (!contains_bounds(level.bounds, bounds)) {
      report(
        diagnostics,
        "RECORD_OUTSIDE_LEVEL",
        "error",
        `${record.kind} ${record.id} ${label} extends outside level ${level.id}.`,
        `record:${record.id}`,
        "Move the record inside the level or enlarge the level bounds.",
      );
    }
  }
  for (const [label, point] of record_points(record)) {
    if (!contains_point(level.bounds, point)) {
      report(
        diagnostics,
        "RECORD_OUTSIDE_LEVEL",
        "error",
        `${record.kind} ${record.id} ${label} (${point.x}, ${point.y}) is outside level ${level.id}.`,
        `record:${record.id}`,
        "Move the point inside the level or enlarge the level bounds.",
      );
    }
  }
  if (record.kind === "slope" && same_point(record.start, record.end)) {
    report(
      diagnostics,
      "INVALID_SLOPE",
      "error",
      `Slope ${record.id} start and end are both (${record.start.x}, ${record.start.y}).`,
      `record:${record.id}`,
      "Move either endpoint to give the slope a length.",
    );
  }
  if (
    record.kind === "platform" &&
    (record.friction < 0 || record.friction > 1)
  ) {
    report(
      diagnostics,
      "INVALID_PLATFORM_FRICTION",
      "error",
      `Platform ${record.id} friction ${record.friction} must be between 0 and 1.`,
      `record:${record.id}`,
      "Choose a friction value from 0 through 1.",
    );
  }
  if (
    record.kind === "hazard" && record.effect.type === "damage" &&
    record.effect.amount <= 0
  ) {
    report(
      diagnostics,
      "INVALID_HAZARD_DAMAGE",
      "error",
      `Hazard ${record.id} damage ${record.effect.amount} must be positive.`,
      `record:${record.id}`,
      "Choose positive damage or make the hazard defeat the player.",
    );
  }
  if (
    record.kind === "collectible" &&
    (!Number.isSafeInteger(record.quantity) || record.quantity <= 0)
  ) {
    report(
      diagnostics,
      "INVALID_COLLECTIBLE_QUANTITY",
      "error",
      `Collectible ${record.id} quantity ${record.quantity} must be a positive safe integer.`,
      `record:${record.id}`,
      "Choose a whole quantity of at least one.",
    );
  }
}

function validate_moving_path(
  level: PlatformerLevel,
  path: Extract<PlatformerRecord, { readonly kind: "moving_path" }>,
  record_by_id: ReadonlyMap<string, PlatformerRecord>,
  diagnostics: AuthoringDiagnostic[],
): void {
  const platform = record_by_id.get(path.platform_id);
  if (platform?.kind !== "platform") {
    report(
      diagnostics,
      "ORPHAN_MOVING_PATH",
      "error",
      `Moving path ${path.id} references ${path.platform_id}, which is not a platform in level ${level.id}.`,
      `record:${path.id}`,
      "Attach the path to an existing platform in this level.",
    );
  }
  const distinct_points = new Set(path.points.map(({ x, y }) => `${x}:${y}`));
  if (path.points.length < 2 || distinct_points.size < 2) {
    report(
      diagnostics,
      "INVALID_MOVING_PATH",
      "error",
      `Moving path ${path.id} needs at least two distinct points; it has ${distinct_points.size}.`,
      `record:${path.id}`,
      "Draw a route between at least two different points.",
    );
  }
  if (path.speed <= 0) {
    report(
      diagnostics,
      "INVALID_MOVING_PATH_SPEED",
      "error",
      `Moving path ${path.id} speed ${path.speed} must be positive.`,
      `record:${path.id}`,
      "Choose a movement speed greater than zero.",
    );
  }
}

function validate_connections(
  level: PlatformerLevel,
  record_by_id: ReadonlyMap<string, PlatformerRecord>,
  level_ids: ReadonlySet<string>,
  diagnostics: AuthoringDiagnostic[],
): void {
  const connection_ids = new Set<string>();
  const connected_triggers = new Set<string>();
  for (const connection of level.connections) {
    if (connection_ids.has(connection.id)) {
      report(
        diagnostics,
        "DUPLICATE_CONNECTION",
        "error",
        `Level ${level.id} contains connection ${connection.id} more than once.`,
        `connection:${connection.id}`,
        "Give every logic connection a unique identity.",
      );
    }
    connection_ids.add(connection.id);
    const source = record_by_id.get(connection.trigger.record_id);
    if (source === undefined) {
      report_orphan_connection(
        diagnostics,
        connection,
        `trigger record ${connection.trigger.record_id} does not exist`,
      );
    } else if (!supports_event(source, connection.trigger.event)) {
      report(
        diagnostics,
        "INVALID_TRIGGER_EVENT",
        "error",
        `Connection ${connection.id} uses event ${connection.trigger.event}, which ${source.kind} ${source.id} cannot emit.`,
        `connection:${connection.id}`,
        "Choose an event emitted by the trigger record.",
      );
    } else {
      connected_triggers.add(source.id);
    }
    validate_condition(
      connection,
      connection.condition,
      record_by_id,
      diagnostics,
    );
    validate_action(
      connection,
      connection.action,
      record_by_id,
      level_ids,
      diagnostics,
    );
  }
  for (const record of record_by_id.values()) {
    if (record.kind === "trigger_zone" && !connected_triggers.has(record.id)) {
      report(
        diagnostics,
        "ORPHAN_TRIGGER_ZONE",
        "warning",
        `Trigger zone ${record.id} has no outgoing logic connection.`,
        `record:${record.id}`,
        "Connect its entered or left event to an action, or remove the unused zone.",
      );
    }
  }
}

function validate_condition(
  connection: PlatformerLogicConnection,
  condition: PlatformerCondition,
  record_by_id: ReadonlyMap<string, PlatformerRecord>,
  diagnostics: AuthoringDiagnostic[],
): void {
  if (condition.type === "always") return;
  const reference = condition.type === "collectible_collected"
    ? condition.collectible_id
    : condition.type === "enemy_defeated"
    ? condition.enemy_id
    : condition.checkpoint_id;
  const expected = condition.type === "collectible_collected"
    ? "collectible"
    : condition.type === "enemy_defeated"
    ? "enemy"
    : "checkpoint";
  if (record_by_id.get(reference)?.kind !== expected) {
    report_orphan_connection(
      diagnostics,
      connection,
      `${condition.type} condition references ${reference}, which is not a ${expected}`,
    );
  }
}

function validate_action(
  connection: PlatformerLogicConnection,
  action: PlatformerAction,
  record_by_id: ReadonlyMap<string, PlatformerRecord>,
  level_ids: ReadonlySet<string>,
  diagnostics: AuthoringDiagnostic[],
): void {
  if (action.type === "complete_level") return;
  if (action.type === "load_level") {
    if (!level_ids.has(action.level_id)) {
      report_orphan_connection(
        diagnostics,
        connection,
        `load-level action references missing level ${action.level_id}`,
      );
    }
    return;
  }
  if (action.type === "start_moving_path") {
    if (record_by_id.get(action.path_id)?.kind !== "moving_path") {
      report_orphan_connection(
        diagnostics,
        connection,
        `start-moving-path action references ${action.path_id}, which is not a moving path`,
      );
    }
    return;
  }
  if (action.type === "activate_checkpoint") {
    if (record_by_id.get(action.checkpoint_id)?.kind !== "checkpoint") {
      report_orphan_connection(
        diagnostics,
        connection,
        `activate-checkpoint action references ${action.checkpoint_id}, which is not a checkpoint`,
      );
    }
    return;
  }
  if (!record_by_id.has(action.record_id)) {
    report_orphan_connection(
      diagnostics,
      connection,
      `${action.type} action references missing record ${action.record_id}`,
    );
  }
}

function report_orphan_connection(
  diagnostics: AuthoringDiagnostic[],
  connection: PlatformerLogicConnection,
  reason: string,
): void {
  report(
    diagnostics,
    "ORPHAN_LOGIC_CONNECTION",
    "error",
    `Connection ${connection.id} is orphaned: ${reason}.`,
    `connection:${connection.id}`,
    "Reconnect it to records in this level or remove the connection.",
  );
}

function supports_event(
  record: PlatformerRecord,
  event: PlatformerTriggerEvent,
): boolean {
  switch (record.kind) {
    case "trigger_zone":
    case "camera_zone":
    case "hazard":
    case "exit":
      return event === "entered" || event === "left";
    case "collectible":
      return event === "collected";
    case "enemy":
      return event === "defeated";
    case "checkpoint":
      return event === "activated";
    case "moving_path":
      return event === "reached";
    case "platform":
    case "slope":
    case "spawn":
      return false;
  }
}

function validate_movement(
  project: PlatformerProject,
  diagnostics: AuthoringDiagnostic[],
): void {
  const positive_settings = [
    ["maximum run speed", project.movement.maximum_run_speed],
    ["ground acceleration", project.movement.ground_acceleration],
    ["air acceleration", project.movement.air_acceleration],
    ["jump speed", project.movement.jump_speed],
    ["gravity", project.movement.gravity],
    ["terminal fall speed", project.movement.terminal_fall_speed],
  ] as const;
  for (const [label, value] of positive_settings) {
    if (value > 0) continue;
    report(
      diagnostics,
      "INVALID_MOVEMENT_SETTING",
      "error",
      `Project ${project.id} ${label} ${value} must be positive.`,
      `project:${project.id}`,
      `Choose a ${label} greater than zero.`,
    );
  }
  const duration_settings = [
    ["coyote time", project.movement.coyote_time_seconds],
    ["jump buffer", project.movement.jump_buffer_seconds],
  ] as const;
  for (const [label, value] of duration_settings) {
    if (value >= 0) continue;
    report(
      diagnostics,
      "INVALID_MOVEMENT_SETTING",
      "error",
      `Project ${project.id} ${label} ${value} cannot be negative.`,
      `project:${project.id}`,
      `Choose a nonnegative ${label}.`,
    );
  }
}

function record_bounds(
  record: PlatformerRecord,
): readonly (readonly [string, PlatformerBounds])[] {
  switch (record.kind) {
    case "platform":
    case "hazard":
    case "checkpoint":
    case "exit":
    case "trigger_zone":
    case "camera_zone":
      return [["bounds", record.bounds]];
    case "enemy":
      return record.patrol_bounds === undefined
        ? []
        : [["patrol bounds", record.patrol_bounds]];
    default:
      return [];
  }
}

function record_points(
  record: PlatformerRecord,
): readonly (readonly [string, PlatformerPoint])[] {
  switch (record.kind) {
    case "slope":
      return [["start", record.start], ["end", record.end]];
    case "spawn":
    case "collectible":
    case "enemy":
      return [["position", record.position]];
    case "checkpoint":
      return [["respawn position", record.respawn_position]];
    case "moving_path":
      return record.points.map((point, index) =>
        [`point ${index}`, point] as const
      );
    default:
      return [];
  }
}

function valid_bounds(bounds: PlatformerBounds): boolean {
  return bounds.maximum.x > bounds.minimum.x &&
    bounds.maximum.y > bounds.minimum.y;
}

function contains_bounds(
  outer: PlatformerBounds,
  inner: PlatformerBounds,
): boolean {
  return contains_point(outer, inner.minimum) &&
    contains_point(outer, inner.maximum);
}

function contains_point(
  bounds: PlatformerBounds,
  point: PlatformerPoint,
): boolean {
  return point.x >= bounds.minimum.x && point.x <= bounds.maximum.x &&
    point.y >= bounds.minimum.y && point.y <= bounds.maximum.y;
}

function same_point(left: PlatformerPoint, right: PlatformerPoint): boolean {
  return left.x === right.x && left.y === right.y;
}

function report(
  diagnostics: AuthoringDiagnostic[],
  code: string,
  severity: AuthoringDiagnostic["severity"],
  message: string,
  subject: string,
  recovery: string,
): void {
  diagnostics.push(
    authoring_diagnostic({ code, severity, message, subject, recovery }),
  );
}
