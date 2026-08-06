import type { AssetId } from "@ink/assets/identity.ts";
import type { Aabb } from "@ink/geometry/shapes.ts";
import type { MaterialInstanceId } from "@ink/materials/identity.ts";
import type { LinearRgba } from "@ink/materials/color.ts";
import type { Vec3 } from "@ink/math/vector.ts";
import type { RenderPhase } from "@ink/rendering/extraction.ts";
import type { EffectDefinitionId, EmitterId } from "./identity.ts";

export interface NumberRange {
  readonly minimum: number;
  readonly maximum: number;
}

export interface ScalarCurvePoint {
  readonly time: number;
  readonly value: number;
}

export interface ColorCurvePoint {
  readonly time: number;
  readonly value: LinearRgba;
}

export type EmitterShape =
  | { readonly type: "point" }
  | { readonly type: "box"; readonly half_extents: Vec3 }
  | { readonly type: "sphere"; readonly radius: number }
  | {
    readonly type: "cone";
    readonly radius: number;
    readonly angle_radians: number;
  };

export interface EmissionBurst {
  readonly time_seconds: number;
  readonly count: number;
}

export interface BillboardRenderModule {
  readonly type: "billboard";
  readonly material: MaterialInstanceId;
  readonly phase: RenderPhase;
  readonly alignment: "camera" | "velocity" | "world_up";
}

export interface MeshRenderModule {
  readonly type: "mesh";
  readonly mesh: AssetId<"mesh">;
  readonly primitive: number;
  readonly material: MaterialInstanceId;
  readonly phase: RenderPhase;
}

export interface RibbonRenderModule {
  readonly type: "ribbon";
  readonly material: MaterialInstanceId;
  readonly phase: RenderPhase;
  readonly maximum_points: number;
}

export interface TrailRenderModule {
  readonly type: "trail";
  readonly material: MaterialInstanceId;
  readonly phase: RenderPhase;
  readonly maximum_points: number;
}

export interface DecalRenderModule {
  readonly type: "decal";
  readonly material: MaterialInstanceId;
  readonly phase: RenderPhase;
  readonly projection_depth: number;
}

export type ParticleRenderModule =
  | BillboardRenderModule
  | MeshRenderModule
  | RibbonRenderModule
  | TrailRenderModule
  | DecalRenderModule;

export interface SpriteAnimation {
  readonly frames: number;
  readonly frames_per_second: number;
  readonly playback: "once" | "loop";
}

export interface CollisionModule {
  readonly source: "depth" | "terrain" | "world";
  readonly restitution: number;
  readonly radius: number;
}

export interface ParticleLightModule {
  readonly color: {
    readonly r: number;
    readonly g: number;
    readonly b: number;
  };
  readonly intensity_candela: number;
  readonly range: number;
  readonly maximum_lights: number;
}

export interface EmitterDefinition {
  readonly id: EmitterId;
  readonly shape: EmitterShape;
  readonly offset: Vec3;
  readonly rate_per_second: number;
  readonly bursts: readonly EmissionBurst[];
  readonly lifetime_seconds: NumberRange;
  readonly speed: NumberRange;
  readonly direction: Vec3;
  readonly force: Vec3;
  readonly drag_per_second: number;
  readonly size: readonly ScalarCurvePoint[];
  readonly color: readonly ColorCurvePoint[];
  readonly rotation_radians: NumberRange;
  readonly angular_velocity_radians: NumberRange;
  readonly sprite?: SpriteAnimation;
  readonly render: ParticleRenderModule;
  readonly collision?: CollisionModule;
  readonly light?: ParticleLightModule;
  readonly capacity: number;
  readonly capacity_policy: "drop_newest" | "drop_oldest";
}

export interface EffectDefinition {
  readonly id: EffectDefinitionId;
  readonly revision: number;
  readonly emitters: readonly EmitterDefinition[];
  readonly bounds:
    | { readonly type: "automatic"; readonly padding: number }
    | { readonly type: "fixed"; readonly value: Aabb };
  readonly offscreen: "simulate" | "pause" | "reduced";
  readonly recovery: "restart" | "finish";
  readonly missing_collision: "no_collision" | "stop";
  readonly required_assets: readonly AssetId[];
}

export interface CreateEffectDefinition extends EffectDefinition {}

export function create_effect_definition(
  input: CreateEffectDefinition,
): EffectDefinition {
  parse_nonnegative_integer(input.revision, `effect ${input.id} revision`);
  if (input.emitters.length === 0) {
    throw new Error(`effect ${input.id} must contain at least one emitter`);
  }
  const emitter_ids = new Set<string>();
  for (const emitter of input.emitters) {
    if (emitter_ids.has(emitter.id)) {
      throw new Error(`effect ${input.id} repeats emitter ${emitter.id}`);
    }
    emitter_ids.add(emitter.id);
    validate_emitter(input.id, emitter);
  }
  if (input.bounds.type === "automatic") {
    parse_nonnegative(
      input.bounds.padding,
      `effect ${input.id} bounds padding`,
    );
  }
  return Object.freeze({
    ...input,
    emitters: Object.freeze(input.emitters.map(freeze_emitter)),
    required_assets: Object.freeze([...input.required_assets]),
  });
}

function validate_emitter(
  effect: EffectDefinitionId,
  emitter: EmitterDefinition,
): void {
  const prefix = `effect ${effect} emitter ${emitter.id}`;
  parse_nonnegative(emitter.rate_per_second, `${prefix} rate`);
  parse_positive_integer(emitter.capacity, `${prefix} capacity`);
  parse_range(emitter.lifetime_seconds, `${prefix} lifetime`);
  parse_range(emitter.speed, `${prefix} speed`);
  if (emitter.lifetime_seconds.minimum < 0) {
    throw new Error(
      `${prefix} lifetime minimum ${emitter.lifetime_seconds.minimum} must be nonnegative`,
    );
  }
  if (emitter.speed.minimum < 0) {
    throw new Error(
      `${prefix} speed minimum ${emitter.speed.minimum} must be nonnegative`,
    );
  }
  parse_range(emitter.rotation_radians, `${prefix} rotation`);
  parse_range(emitter.angular_velocity_radians, `${prefix} angular velocity`);
  parse_nonnegative(emitter.drag_per_second, `${prefix} drag`);
  if (
    emitter.direction.x === 0 && emitter.direction.y === 0 &&
    emitter.direction.z === 0
  ) {
    throw new Error(`${prefix} direction cannot be zero`);
  }
  if (emitter.shape.type === "sphere" || emitter.shape.type === "cone") {
    parse_nonnegative(emitter.shape.radius, `${prefix} shape radius`);
  }
  if (
    emitter.shape.type === "box" &&
    (emitter.shape.half_extents.x < 0 || emitter.shape.half_extents.y < 0 ||
      emitter.shape.half_extents.z < 0)
  ) {
    throw new Error(
      `${prefix} box half-extents (${emitter.shape.half_extents.x}, ${emitter.shape.half_extents.y}, ${emitter.shape.half_extents.z}) must be nonnegative`,
    );
  }
  if (emitter.shape.type === "cone") {
    if (
      !Number.isFinite(emitter.shape.angle_radians) ||
      emitter.shape.angle_radians < 0 || emitter.shape.angle_radians > Math.PI
    ) {
      throw new Error(
        `${prefix} cone angle ${emitter.shape.angle_radians} must be within [0, pi]`,
      );
    }
  }
  validate_scalar_curve(emitter.size, `${prefix} size`);
  validate_color_curve(emitter.color, `${prefix} color`);
  for (const [index, burst] of emitter.bursts.entries()) {
    parse_nonnegative(burst.time_seconds, `${prefix} burst ${index} time`);
    parse_nonnegative_integer(burst.count, `${prefix} burst ${index} count`);
    if (
      index > 0 && burst.time_seconds < emitter.bursts[index - 1].time_seconds
    ) {
      throw new Error(`${prefix} bursts must be ordered by time`);
    }
  }
  if (emitter.sprite !== undefined) {
    parse_positive_integer(emitter.sprite.frames, `${prefix} sprite frames`);
    parse_nonnegative(
      emitter.sprite.frames_per_second,
      `${prefix} sprite rate`,
    );
  }
  if (emitter.render.type === "mesh") {
    parse_nonnegative_integer(
      emitter.render.primitive,
      `${prefix} mesh primitive`,
    );
  }
  if (emitter.render.type === "ribbon" || emitter.render.type === "trail") {
    parse_positive_integer(
      emitter.render.maximum_points,
      `${prefix} maximum points`,
    );
  }
  if (emitter.render.type === "decal") {
    parse_nonnegative(
      emitter.render.projection_depth,
      `${prefix} projection depth`,
    );
  }
  if (emitter.collision !== undefined) {
    parse_nonnegative(emitter.collision.radius, `${prefix} collision radius`);
    if (
      !Number.isFinite(emitter.collision.restitution) ||
      emitter.collision.restitution < 0 || emitter.collision.restitution > 1
    ) {
      throw new Error(
        `${prefix} collision restitution ${emitter.collision.restitution} must be within [0, 1]`,
      );
    }
  }
  if (emitter.light !== undefined) {
    parse_positive(
      emitter.light.intensity_candela,
      `${prefix} light intensity`,
    );
    parse_positive(emitter.light.range, `${prefix} light range`);
    parse_nonnegative_integer(
      emitter.light.maximum_lights,
      `${prefix} maximum lights`,
    );
    for (const [channel, value] of Object.entries(emitter.light.color)) {
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(
          `${prefix} light color ${channel} ${value} must be within [0, 1]`,
        );
      }
    }
  }
}

function validate_scalar_curve(
  curve: readonly ScalarCurvePoint[],
  label: string,
): void {
  if (curve.length === 0) throw new Error(`${label} curve cannot be empty`);
  for (const [index, point] of curve.entries()) {
    parse_unit_time(point.time, `${label} point ${index}`);
    if (!Number.isFinite(point.value)) {
      throw new Error(
        `${label} point ${index} value ${point.value} must be finite`,
      );
    }
    if (index > 0 && point.time <= curve[index - 1].time) {
      throw new Error(`${label} curve times must increase`);
    }
  }
}

function validate_color_curve(
  curve: readonly ColorCurvePoint[],
  label: string,
): void {
  if (curve.length === 0) throw new Error(`${label} curve cannot be empty`);
  for (const [index, point] of curve.entries()) {
    parse_unit_time(point.time, `${label} point ${index}`);
    if (index > 0 && point.time <= curve[index - 1].time) {
      throw new Error(`${label} curve times must increase`);
    }
  }
}

function freeze_emitter(emitter: EmitterDefinition): EmitterDefinition {
  return Object.freeze({
    ...emitter,
    bursts: Object.freeze(
      emitter.bursts.map((burst) => Object.freeze({ ...burst })),
    ),
    size: Object.freeze(
      emitter.size.map((point) => Object.freeze({ ...point })),
    ),
    color: Object.freeze(
      emitter.color.map((point) => Object.freeze({ ...point })),
    ),
  });
}

function parse_range(range: NumberRange, label: string): void {
  if (
    !Number.isFinite(range.minimum) || !Number.isFinite(range.maximum) ||
    range.minimum > range.maximum
  ) {
    throw new Error(
      `${label} range [${range.minimum}, ${range.maximum}] must be finite and ordered`,
    );
  }
}

function parse_unit_time(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} time ${value} must be within [0, 1]`);
  }
}

function parse_nonnegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} ${value} must be finite and nonnegative`);
  }
}

function parse_positive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} ${value} must be finite and positive`);
  }
}

function parse_nonnegative_integer(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} ${value} must be a nonnegative safe integer`);
  }
}

function parse_positive_integer(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} ${value} must be a positive safe integer`);
  }
}
