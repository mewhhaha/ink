import { asset_id } from "@ink/assets/identity.ts";
import { linear_rgba } from "@ink/materials/color.ts";
import { material_instance_id } from "@ink/materials/identity.ts";
import { vec3 } from "@ink/math/vector.ts";
import {
  create_effect_definition,
  type EffectDefinition,
  type EmitterDefinition,
} from "./definition.ts";
import { effect_definition_id, emitter_id } from "./identity.ts";

export function emitter_fixture(
  overrides: Partial<EmitterDefinition> = {},
): EmitterDefinition {
  return {
    id: emitter_id("embers"),
    shape: { type: "point" },
    offset: vec3(0, 0, 0),
    rate_per_second: 4,
    bursts: [{ time_seconds: 0, count: 3 }],
    lifetime_seconds: { minimum: 2, maximum: 2 },
    speed: { minimum: 1, maximum: 1 },
    direction: vec3(0, 1, 0),
    force: vec3(0, -1, 0),
    drag_per_second: 0,
    size: [{ time: 0, value: 1 }, { time: 1, value: 0 }],
    color: [
      { time: 0, value: linear_rgba(1, 0.5, 0, 1) },
      { time: 1, value: linear_rgba(0.1, 0, 0, 0) },
    ],
    rotation_radians: { minimum: 0, maximum: 0 },
    angular_velocity_radians: { minimum: 2, maximum: 2 },
    sprite: { frames: 4, frames_per_second: 4, playback: "loop" },
    render: {
      type: "billboard",
      material: material_instance_id("vfx/ember"),
      phase: "transparent",
      alignment: "camera",
    },
    capacity: 32,
    capacity_policy: "drop_newest",
    ...overrides,
  };
}

export function effect_fixture(
  overrides: Partial<EffectDefinition> = {},
): EffectDefinition {
  return create_effect_definition({
    id: effect_definition_id("campfire"),
    revision: 1,
    emitters: [emitter_fixture()],
    bounds: { type: "automatic", padding: 0.25 },
    offscreen: "simulate",
    recovery: "restart",
    missing_collision: "no_collision",
    required_assets: [asset_id("textures/embers")],
    ...overrides,
  });
}
