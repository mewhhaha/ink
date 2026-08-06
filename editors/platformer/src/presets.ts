import {
  editor_preset_id,
  type EditorPresetId,
} from "@ink/authoring/identity.ts";
import type { PlatformerCamera, PlatformerMovement } from "./model.ts";

export interface PlatformerPreset {
  readonly id: EditorPresetId;
  readonly label: string;
  readonly summary: string;
  readonly characteristic_mechanics: readonly string[];
  readonly movement: PlatformerMovement;
  readonly camera: PlatformerCamera;
  readonly default_mechanics: readonly string[];
}

const presets = Object.freeze([
  preset(
    "classic-adventure",
    "Classic adventure",
    "Readable jumps and a gently following camera.",
    movement({
      run: 7,
      ground: 52,
      air: 22,
      jump: 12,
      gravity: 30,
      fall: 22,
      coyote: 0.1,
      buffer: 0.1,
    }),
    camera("follow", 8, 1.5, 3, 2, 0.7),
    ["checkpoints", "collectibles", "moving platforms"],
  ),
  preset(
    "precision",
    "Precision",
    "Immediate control, short forgiveness windows, and a stable room camera.",
    movement({
      run: 8,
      ground: 90,
      air: 72,
      jump: 13,
      gravity: 38,
      fall: 27,
      coyote: 0.06,
      buffer: 0.08,
    }),
    camera("room", 16, 0, 1, 1, 0.25),
    ["instant retry", "hazards", "checkpoints"],
  ),
  preset(
    "momentum",
    "Momentum",
    "Long acceleration arcs reward preserving speed through the level.",
    movement({
      run: 14,
      ground: 20,
      air: 8,
      jump: 11,
      gravity: 25,
      fall: 24,
      coyote: 0.12,
      buffer: 0.08,
    }),
    camera("forward_focus", 5, 6, 5, 2.5, 0.55),
    ["speed routes", "slopes", "moving platforms"],
  ),
  preset(
    "aerial-acrobatics",
    "Aerial acrobatics",
    "Double jumps, wall jumps, and dashes support expressive air routes.",
    movement({
      run: 9,
      ground: 64,
      air: 54,
      jump: 12.5,
      gravity: 28,
      fall: 20,
      coyote: 0.12,
      buffer: 0.12,
      jumps: 2,
      wall: true,
      dash: true,
    }),
    camera("follow", 10, 2.5, 4, 3.5, 0.9),
    ["double jump", "wall jump", "air dash"],
  ),
  preset(
    "exploration",
    "Exploration",
    "Measured movement and roomy camera framing favor interconnected spaces.",
    movement({
      run: 6.5,
      ground: 42,
      air: 18,
      jump: 11,
      gravity: 27,
      fall: 19,
      coyote: 0.14,
      buffer: 0.12,
      wall: true,
    }),
    camera("room", 4, 1, 6, 4, 0.45),
    ["ability gates", "backtracking", "collectibles"],
  ),
  preset(
    "auto-runner",
    "Auto-runner",
    "Constant forward pressure shifts authorship toward timing and lane rhythm.",
    movement({
      run: 11,
      ground: 120,
      air: 16,
      jump: 11.5,
      gravity: 32,
      fall: 24,
      coyote: 0.08,
      buffer: 0.14,
    }),
    camera("forward_focus", 12, 8, 2, 1.5, 0.35),
    ["automatic running", "single-button jump", "paced hazards"],
  ),
  preset(
    "puzzle-platformer",
    "Puzzle platformer",
    "Low speed and a fixed composition leave room for trigger-driven mechanisms.",
    movement({
      run: 4.5,
      ground: 36,
      air: 12,
      jump: 9,
      gravity: 24,
      fall: 16,
      coyote: 0.16,
      buffer: 0.14,
    }),
    camera("room", 18, 0, 0.5, 0.5, 0.1),
    ["trigger zones", "moving platforms", "collectible conditions"],
  ),
  preset(
    "cinematic-chase",
    "Cinematic chase",
    "Directed framing and brisk movement support authored chase sequences.",
    movement({
      run: 10,
      ground: 46,
      air: 20,
      jump: 12,
      gravity: 29,
      fall: 23,
      coyote: 0.1,
      buffer: 0.1,
      dash: true,
    }),
    camera("cinematic", 3, 5, 4, 2, 0.75),
    ["camera zones", "scripted triggers", "chase pacing"],
  ),
]);

export function list_platformer_presets(): readonly PlatformerPreset[] {
  return presets;
}

export function platformer_preset(
  identity: EditorPresetId | string,
): PlatformerPreset {
  const found = presets.find(({ id }) => id === identity);
  if (found === undefined) {
    throw new Error(
      `platformer preset ${JSON.stringify(identity)} does not exist`,
    );
  }
  return found;
}

interface MovementValues {
  readonly run: number;
  readonly ground: number;
  readonly air: number;
  readonly jump: number;
  readonly gravity: number;
  readonly fall: number;
  readonly coyote: number;
  readonly buffer: number;
  readonly jumps?: 1 | 2;
  readonly variable?: boolean;
  readonly wall?: boolean;
  readonly dash?: boolean;
}

function movement(values: MovementValues): PlatformerMovement {
  return Object.freeze({
    maximum_run_speed: values.run,
    ground_acceleration: values.ground,
    air_acceleration: values.air,
    jump_speed: values.jump,
    gravity: values.gravity,
    terminal_fall_speed: values.fall,
    coyote_time_seconds: values.coyote,
    jump_buffer_seconds: values.buffer,
    available_jumps: values.jumps ?? 1,
    variable_jump: values.variable ?? true,
    wall_jump: values.wall ?? false,
    dash: values.dash ?? false,
  });
}

function camera(
  mode: PlatformerCamera["mode"],
  smoothing: number,
  look_ahead: number,
  dead_zone_width: number,
  dead_zone_height: number,
  vertical_tracking: number,
): PlatformerCamera {
  return Object.freeze({
    mode,
    smoothing,
    look_ahead,
    dead_zone_width,
    dead_zone_height,
    vertical_tracking,
  });
}

function preset(
  identity: string,
  label: string,
  summary: string,
  movement_settings: PlatformerMovement,
  camera_settings: PlatformerCamera,
  mechanics: readonly string[],
): PlatformerPreset {
  return Object.freeze({
    id: editor_preset_id(identity),
    label,
    summary,
    characteristic_mechanics: Object.freeze([...mechanics]),
    movement: movement_settings,
    camera: camera_settings,
    default_mechanics: Object.freeze([...mechanics]),
  });
}
