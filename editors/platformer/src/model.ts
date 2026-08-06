import type { EditorPresetId } from "@ink/authoring/identity.ts";
import type {
  PlatformerConnectionId,
  PlatformerLayerId,
  PlatformerLevelId,
  PlatformerProjectId,
  PlatformerRecordId,
} from "./identity.ts";

export interface PlatformerPoint {
  readonly x: number;
  readonly y: number;
}

export interface PlatformerBounds {
  readonly minimum: PlatformerPoint;
  readonly maximum: PlatformerPoint;
}

export interface PlatformerMovement {
  readonly maximum_run_speed: number;
  readonly ground_acceleration: number;
  readonly air_acceleration: number;
  readonly jump_speed: number;
  readonly gravity: number;
  readonly terminal_fall_speed: number;
  readonly coyote_time_seconds: number;
  readonly jump_buffer_seconds: number;
  readonly available_jumps: 1 | 2;
  readonly variable_jump: boolean;
  readonly wall_jump: boolean;
  readonly dash: boolean;
}

export type PlatformerCameraMode =
  | "follow"
  | "forward_focus"
  | "room"
  | "cinematic";

export interface PlatformerCamera {
  readonly mode: PlatformerCameraMode;
  readonly smoothing: number;
  readonly look_ahead: number;
  readonly dead_zone_width: number;
  readonly dead_zone_height: number;
  readonly vertical_tracking: number;
}

interface PlatformerRecordBase {
  readonly id: PlatformerRecordId;
  readonly name: string;
}

export interface PlatformRecord extends PlatformerRecordBase {
  readonly kind: "platform";
  readonly bounds: PlatformerBounds;
  readonly surface: "solid" | "one_way";
  readonly friction: number;
}

export interface SlopeRecord extends PlatformerRecordBase {
  readonly kind: "slope";
  readonly start: PlatformerPoint;
  readonly end: PlatformerPoint;
  readonly surface: "solid" | "one_way";
}

export interface HazardRecord extends PlatformerRecordBase {
  readonly kind: "hazard";
  readonly bounds: PlatformerBounds;
  readonly effect:
    | { readonly type: "defeat" }
    | { readonly type: "damage"; readonly amount: number };
}

export interface SpawnRecord extends PlatformerRecordBase {
  readonly kind: "spawn";
  readonly position: PlatformerPoint;
  readonly facing: "left" | "right";
}

export interface CheckpointRecord extends PlatformerRecordBase {
  readonly kind: "checkpoint";
  readonly bounds: PlatformerBounds;
  readonly respawn_position: PlatformerPoint;
}

export type ExitDestination =
  | { readonly type: "complete" }
  | { readonly type: "level"; readonly level_id: PlatformerLevelId };

export interface ExitRecord extends PlatformerRecordBase {
  readonly kind: "exit";
  readonly bounds: PlatformerBounds;
  readonly destination: ExitDestination;
}

export interface CollectibleRecord extends PlatformerRecordBase {
  readonly kind: "collectible";
  readonly position: PlatformerPoint;
  readonly collectible_key: string;
  readonly quantity: number;
}

export interface EnemyRecord extends PlatformerRecordBase {
  readonly kind: "enemy";
  readonly position: PlatformerPoint;
  readonly archetype: string;
  readonly patrol_bounds?: PlatformerBounds;
}

export interface MovingPathRecord extends PlatformerRecordBase {
  readonly kind: "moving_path";
  readonly platform_id: PlatformerRecordId;
  readonly points: readonly PlatformerPoint[];
  readonly speed: number;
  readonly traversal: "cycle" | "ping_pong";
}

export interface TriggerZoneRecord extends PlatformerRecordBase {
  readonly kind: "trigger_zone";
  readonly bounds: PlatformerBounds;
  readonly activation: "once" | "repeat";
}

export interface CameraZoneRecord extends PlatformerRecordBase {
  readonly kind: "camera_zone";
  readonly bounds: PlatformerBounds;
  readonly camera: PlatformerCamera;
  readonly priority: number;
}

export type PlatformerRecord =
  | PlatformRecord
  | SlopeRecord
  | HazardRecord
  | SpawnRecord
  | CheckpointRecord
  | ExitRecord
  | CollectibleRecord
  | EnemyRecord
  | MovingPathRecord
  | TriggerZoneRecord
  | CameraZoneRecord;

export type PlatformerLayerKind =
  | "collision"
  | "gameplay"
  | "logic"
  | "camera"
  | "decoration";

export interface PlatformerLayer {
  readonly id: PlatformerLayerId;
  readonly name: string;
  readonly kind: PlatformerLayerKind;
  readonly depth: number;
  readonly records: readonly PlatformerRecord[];
}

export type PlatformerTriggerEvent =
  | "entered"
  | "left"
  | "collected"
  | "defeated"
  | "activated"
  | "reached";

export interface PlatformerTrigger {
  readonly record_id: PlatformerRecordId;
  readonly event: PlatformerTriggerEvent;
}

export type PlatformerCondition =
  | { readonly type: "always" }
  | {
    readonly type: "collectible_collected";
    readonly collectible_id: PlatformerRecordId;
  }
  | {
    readonly type: "enemy_defeated";
    readonly enemy_id: PlatformerRecordId;
  }
  | {
    readonly type: "checkpoint_reached";
    readonly checkpoint_id: PlatformerRecordId;
  };

export type PlatformerAction =
  | {
    readonly type: "enable_record" | "disable_record";
    readonly record_id: PlatformerRecordId;
  }
  | {
    readonly type: "start_moving_path";
    readonly path_id: PlatformerRecordId;
  }
  | {
    readonly type: "activate_checkpoint";
    readonly checkpoint_id: PlatformerRecordId;
  }
  | { readonly type: "load_level"; readonly level_id: PlatformerLevelId }
  | { readonly type: "complete_level" };

export interface PlatformerLogicConnection {
  readonly id: PlatformerConnectionId;
  readonly trigger: PlatformerTrigger;
  readonly condition: PlatformerCondition;
  readonly action: PlatformerAction;
}

export interface PlatformerLevel {
  readonly id: PlatformerLevelId;
  readonly name: string;
  readonly bounds: PlatformerBounds;
  readonly kill_plane_y: number;
  readonly layers: readonly PlatformerLayer[];
  readonly connections: readonly PlatformerLogicConnection[];
}

export interface PlatformerProject {
  readonly schema_version: 1;
  readonly id: PlatformerProjectId;
  readonly name: string;
  readonly preset_id: EditorPresetId;
  readonly movement: PlatformerMovement;
  readonly camera: PlatformerCamera;
  readonly default_mechanics: readonly string[];
  readonly entry_level_id: PlatformerLevelId;
  readonly levels: readonly PlatformerLevel[];
}

export function platformer_project(
  project: PlatformerProject,
): PlatformerProject {
  const name = required_text(
    project.name,
    `platformer project ${project.id} name`,
  );
  const levels = project.levels.map(freeze_level);
  const mechanics = project.default_mechanics.map((mechanic, index) =>
    required_text(
      mechanic,
      `platformer project ${project.id} mechanic ${index}`,
    )
  );
  return Object.freeze({
    schema_version: 1,
    id: project.id,
    name,
    preset_id: project.preset_id,
    movement: freeze_movement(project.movement),
    camera: freeze_camera(project.camera),
    default_mechanics: Object.freeze(mechanics),
    entry_level_id: project.entry_level_id,
    levels: Object.freeze(levels),
  });
}

function freeze_level(level: PlatformerLevel): PlatformerLevel {
  return Object.freeze({
    id: level.id,
    name: required_text(level.name, `platformer level ${level.id} name`),
    bounds: freeze_bounds(level.bounds),
    kill_plane_y: finite(level.kill_plane_y, `level ${level.id} kill plane`),
    layers: Object.freeze(level.layers.map(freeze_layer)),
    connections: Object.freeze(level.connections.map(freeze_connection)),
  });
}

function freeze_layer(layer: PlatformerLayer): PlatformerLayer {
  return Object.freeze({
    id: layer.id,
    name: required_text(layer.name, `platformer layer ${layer.id} name`),
    kind: layer.kind,
    depth: finite(layer.depth, `layer ${layer.id} depth`),
    records: Object.freeze(layer.records.map(freeze_record)),
  });
}

function freeze_record(record: PlatformerRecord): PlatformerRecord {
  const common = {
    id: record.id,
    name: required_text(record.name, `platformer record ${record.id} name`),
  };
  switch (record.kind) {
    case "platform":
      return Object.freeze({
        ...common,
        kind: record.kind,
        bounds: freeze_bounds(record.bounds),
        surface: record.surface,
        friction: finite(record.friction, `platform ${record.id} friction`),
      });
    case "slope":
      return Object.freeze({
        ...common,
        kind: record.kind,
        start: freeze_point(record.start),
        end: freeze_point(record.end),
        surface: record.surface,
      });
    case "hazard":
      return Object.freeze({
        ...common,
        kind: record.kind,
        bounds: freeze_bounds(record.bounds),
        effect: record.effect.type === "defeat"
          ? Object.freeze({ type: "defeat" as const })
          : Object.freeze({
            type: "damage" as const,
            amount: finite(record.effect.amount, `hazard ${record.id} damage`),
          }),
      });
    case "spawn":
      return Object.freeze({
        ...common,
        kind: record.kind,
        position: freeze_point(record.position),
        facing: record.facing,
      });
    case "checkpoint":
      return Object.freeze({
        ...common,
        kind: record.kind,
        bounds: freeze_bounds(record.bounds),
        respawn_position: freeze_point(record.respawn_position),
      });
    case "exit":
      return Object.freeze({
        ...common,
        kind: record.kind,
        bounds: freeze_bounds(record.bounds),
        destination: Object.freeze({ ...record.destination }),
      });
    case "collectible":
      return Object.freeze({
        ...common,
        kind: record.kind,
        position: freeze_point(record.position),
        collectible_key: required_text(
          record.collectible_key,
          `collectible ${record.id} key`,
        ),
        quantity: finite(record.quantity, `collectible ${record.id} quantity`),
      });
    case "enemy":
      return Object.freeze({
        ...common,
        kind: record.kind,
        position: freeze_point(record.position),
        archetype: required_text(
          record.archetype,
          `enemy ${record.id} archetype`,
        ),
        ...(record.patrol_bounds === undefined
          ? {}
          : { patrol_bounds: freeze_bounds(record.patrol_bounds) }),
      });
    case "moving_path":
      return Object.freeze({
        ...common,
        kind: record.kind,
        platform_id: record.platform_id,
        points: Object.freeze(record.points.map(freeze_point)),
        speed: finite(record.speed, `moving path ${record.id} speed`),
        traversal: record.traversal,
      });
    case "trigger_zone":
      return Object.freeze({
        ...common,
        kind: record.kind,
        bounds: freeze_bounds(record.bounds),
        activation: record.activation,
      });
    case "camera_zone":
      return Object.freeze({
        ...common,
        kind: record.kind,
        bounds: freeze_bounds(record.bounds),
        camera: freeze_camera(record.camera),
        priority: finite(record.priority, `camera zone ${record.id} priority`),
      });
  }
}

function freeze_connection(
  connection: PlatformerLogicConnection,
): PlatformerLogicConnection {
  return Object.freeze({
    id: connection.id,
    trigger: Object.freeze({ ...connection.trigger }),
    condition: Object.freeze({ ...connection.condition }),
    action: Object.freeze({ ...connection.action }),
  });
}

function freeze_movement(movement: PlatformerMovement): PlatformerMovement {
  return Object.freeze({
    ...movement,
    maximum_run_speed: finite(movement.maximum_run_speed, "maximum run speed"),
    ground_acceleration: finite(
      movement.ground_acceleration,
      "ground acceleration",
    ),
    air_acceleration: finite(movement.air_acceleration, "air acceleration"),
    jump_speed: finite(movement.jump_speed, "jump speed"),
    gravity: finite(movement.gravity, "gravity"),
    terminal_fall_speed: finite(
      movement.terminal_fall_speed,
      "terminal fall speed",
    ),
    coyote_time_seconds: finite(movement.coyote_time_seconds, "coyote time"),
    jump_buffer_seconds: finite(movement.jump_buffer_seconds, "jump buffer"),
  });
}

function freeze_camera(camera: PlatformerCamera): PlatformerCamera {
  return Object.freeze({
    ...camera,
    smoothing: finite(camera.smoothing, "camera smoothing"),
    look_ahead: finite(camera.look_ahead, "camera look ahead"),
    dead_zone_width: finite(camera.dead_zone_width, "camera dead zone width"),
    dead_zone_height: finite(
      camera.dead_zone_height,
      "camera dead zone height",
    ),
    vertical_tracking: finite(
      camera.vertical_tracking,
      "camera vertical tracking",
    ),
  });
}

function freeze_bounds(bounds: PlatformerBounds): PlatformerBounds {
  return Object.freeze({
    minimum: freeze_point(bounds.minimum),
    maximum: freeze_point(bounds.maximum),
  });
}

function freeze_point(point: PlatformerPoint): PlatformerPoint {
  return Object.freeze({
    x: finite(point.x, "platformer point x"),
    y: finite(point.y, "platformer point y"),
  });
}

function required_text(value: string, label: string): string {
  const parsed = value.trim();
  if (parsed.length === 0) throw new Error(`${label} cannot be empty`);
  return parsed;
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} ${String(value)} must be finite`);
  }
  return value;
}
