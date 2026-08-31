import type { CameraView } from "@ink/camera/view.ts";
import { type Vec3, vec3 } from "@ink/math/vector.ts";
import type { Observer } from "@ink/observability/observer.ts";
import type { LightId } from "../identity.ts";
import type { LightDefinition, ShadowQuality } from "../model.ts";

export type ShadowInvalidationReason =
  | "dynamic"
  | "new"
  | "light_revision"
  | "caster_revision"
  | "camera_cascade"
  | "quality"
  | "scheduled";

export interface ShadowCacheEntry {
  readonly light: LightId;
  readonly light_revision: number;
  readonly caster_revision: number;
  readonly camera_revision: number;
  readonly quality_signature: string;
  readonly rendered_frame: number;
}

export interface ShadowAtlasTile {
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

export interface ShadowView {
  readonly id: string;
  readonly light: LightId;
  readonly kind: "directional_cascade" | "spot" | "point_face" | "rectangular";
  readonly position: Vec3;
  readonly direction: Vec3;
  readonly up: Vec3;
  readonly projection:
    | { readonly type: "orthographic"; readonly vertical_size: number }
    | { readonly type: "perspective"; readonly vertical_fov_radians: number };
  readonly near: number;
  readonly far: number;
  readonly cascade?: number;
  readonly point_face?: number;
  readonly atlas: ShadowAtlasTile;
  readonly depth_bias: number;
  readonly normal_bias: number;
  readonly filter: Exclude<
    LightDefinition["shadow"],
    { type: "off" }
  >["filter"];
}

export interface ShadowInvalidation {
  readonly light: LightId;
  readonly action: "render" | "reuse";
  readonly reason?: ShadowInvalidationReason;
}

export interface ShadowPlan {
  readonly atlas_size: number;
  readonly views: readonly ShadowView[];
  readonly invalidations: readonly ShadowInvalidation[];
  readonly overflow: readonly LightId[];
  readonly cache: ReadonlyMap<LightId, ShadowCacheEntry>;
}

export interface ShadowPlanInput {
  readonly view: CameraView;
  readonly camera_revision: number;
  readonly caster_revision: number;
  readonly frame_index: number;
  readonly lights: readonly LightDefinition[];
  readonly quality: ShadowQuality;
  readonly previous_cache?: ReadonlyMap<LightId, ShadowCacheEntry>;
  readonly observer?: Observer;
}

type ShadowCastingLight =
  & Exclude<LightDefinition, { readonly type: "environment" }>
  & {
    readonly shadow: Exclude<
      LightDefinition["shadow"],
      { readonly type: "off" }
    >;
  };

function casts_shadow(light: LightDefinition): light is ShadowCastingLight {
  return light.type !== "environment" && light.shadow.type !== "off";
}

export function cascade_partitions(
  near: number,
  far: number,
  count: number,
  lambda: number,
): readonly number[] {
  if (
    !Number.isFinite(near) || !Number.isFinite(far) || near <= 0 || far <= near
  ) {
    throw new Error(
      `shadow cascade range [${near}, ${far}] must be finite and increasing`,
    );
  }
  if (!Number.isSafeInteger(count) || count < 1 || count > 4) {
    throw new Error(`shadow cascade count ${count} must be within [1, 4]`);
  }
  if (!Number.isFinite(lambda) || lambda < 0 || lambda > 1) {
    throw new Error(`shadow cascade lambda ${lambda} must be within [0, 1]`);
  }
  const splits: number[] = [];
  for (let index = 1; index <= count; index += 1) {
    const amount = index / count;
    const logarithmic = index === count ? far : Math.exp(
      Math.log(near) * (1 - amount) + Math.log(far) * amount,
    );
    const uniform = near + (far - near) * amount;
    splits.push(logarithmic * lambda + uniform * (1 - lambda));
  }
  return Object.freeze(splits);
}

interface AtlasCursor {
  x: number;
  y: number;
  row_height: number;
}

function allocate_group(
  cursor: AtlasCursor,
  count: number,
  size: number,
  atlas_size: number,
): readonly ShadowAtlasTile[] | null {
  const trial = { ...cursor };
  const tiles: ShadowAtlasTile[] = [];
  for (let index = 0; index < count; index += 1) {
    if (trial.x + size > atlas_size) {
      trial.x = 0;
      trial.y += trial.row_height;
      trial.row_height = 0;
    }
    if (trial.y + size > atlas_size) return null;
    tiles.push(Object.freeze({ x: trial.x, y: trial.y, size }));
    trial.x += size;
    trial.row_height = Math.max(trial.row_height, size);
  }
  cursor.x = trial.x;
  cursor.y = trial.y;
  cursor.row_height = trial.row_height;
  return Object.freeze(tiles);
}

function view_count(light: ShadowCastingLight, cascades: number): number {
  if (light.type === "directional") return cascades;
  if (light.type === "point") return 6;
  return 1;
}

const point_faces: readonly { direction: Vec3; up: Vec3 }[] = Object.freeze([
  { direction: vec3(1, 0, 0), up: vec3(0, -1, 0) },
  { direction: vec3(-1, 0, 0), up: vec3(0, -1, 0) },
  { direction: vec3(0, 1, 0), up: vec3(0, 0, 1) },
  { direction: vec3(0, -1, 0), up: vec3(0, 0, -1) },
  { direction: vec3(0, 0, 1), up: vec3(0, -1, 0) },
  { direction: vec3(0, 0, -1), up: vec3(0, -1, 0) },
]);

function shadow_views(
  light: ShadowCastingLight,
  view: CameraView,
  splits: readonly number[],
  tiles: readonly ShadowAtlasTile[],
): readonly ShadowView[] {
  if (light.type === "directional") {
    let previous = view.projection.near;
    return Object.freeze(splits.map((split, cascade) => {
      const vertical_size = split * 2;
      const shadow_view: ShadowView = {
        id: `${light.id}:cascade:${cascade}`,
        light: light.id,
        kind: "directional_cascade",
        position: view.pose.position,
        direction: light.direction,
        up: Math.abs(light.direction.y) > 0.99 ? vec3(1, 0, 0) : vec3(0, 1, 0),
        projection: { type: "orthographic", vertical_size },
        near: previous,
        far: split,
        cascade,
        atlas: tiles[cascade],
        depth_bias: light.shadow.depth_bias,
        normal_bias: light.shadow.normal_bias,
        filter: light.shadow.filter,
      };
      previous = split;
      return Object.freeze(shadow_view);
    }));
  }
  if (light.type === "point") {
    return Object.freeze(point_faces.map((face, index) =>
      Object.freeze({
        id: `${light.id}:face:${index}`,
        light: light.id,
        kind: "point_face" as const,
        position: light.position,
        direction: face.direction,
        up: face.up,
        projection: {
          type: "perspective" as const,
          vertical_fov_radians: Math.PI / 2,
        },
        near: Math.max(0.01, light.source_radius),
        far: light.range,
        point_face: index,
        atlas: tiles[index],
        depth_bias: light.shadow.depth_bias,
        normal_bias: light.shadow.normal_bias,
        filter: light.shadow.filter,
      })
    ));
  }
  const direction = light.type === "spot" ? light.direction : light.normal;
  const fov = light.type === "spot"
    ? light.outer_angle_radians * 2
    : Math.PI / 2;
  return Object.freeze([Object.freeze({
    id: `${light.id}:view`,
    light: light.id,
    kind: light.type === "spot" ? "spot" as const : "rectangular" as const,
    position: light.position,
    direction,
    up: Math.abs(direction.y) > 0.99 ? vec3(1, 0, 0) : vec3(0, 1, 0),
    projection: { type: "perspective" as const, vertical_fov_radians: fov },
    near: light.type === "spot" ? Math.max(0.01, light.source_radius) : 0.01,
    far: light.range,
    atlas: tiles[0],
    depth_bias: light.shadow.depth_bias,
    normal_bias: light.shadow.normal_bias,
    filter: light.shadow.filter,
  })]);
}

function invalidation(
  light: ShadowCastingLight,
  input: ShadowPlanInput,
  signature: string,
): ShadowInvalidation {
  if (light.shadow.type === "dynamic") {
    return { light: light.id, action: "render", reason: "dynamic" };
  }
  const previous = input.previous_cache?.get(light.id);
  if (previous === undefined) {
    return { light: light.id, action: "render", reason: "new" };
  }
  if (previous.light_revision !== light.revision) {
    return { light: light.id, action: "render", reason: "light_revision" };
  }
  if (previous.caster_revision !== input.caster_revision) {
    return { light: light.id, action: "render", reason: "caster_revision" };
  }
  if (previous.quality_signature !== signature) {
    return { light: light.id, action: "render", reason: "quality" };
  }
  if (
    light.type === "directional" &&
    previous.camera_revision !== input.camera_revision
  ) {
    return { light: light.id, action: "render", reason: "camera_cascade" };
  }
  if (
    input.frame_index - previous.rendered_frame >=
      light.shadow.update_interval_frames *
        input.quality.cached_update_interval_multiplier
  ) {
    return { light: light.id, action: "render", reason: "scheduled" };
  }
  return { light: light.id, action: "reuse" };
}

export function build_shadow_plan(input: ShadowPlanInput): ShadowPlan {
  if (![1024, 2048, 4096, 8192].includes(input.quality.atlas_size)) {
    throw new Error(
      `shadow atlas size ${input.quality.atlas_size} is unsupported`,
    );
  }
  if (![128, 256, 512].includes(input.quality.minimum_resolution)) {
    throw new Error(
      `shadow minimum resolution ${input.quality.minimum_resolution} is unsupported`,
    );
  }
  if (
    !Number.isSafeInteger(input.quality.maximum_shadowed_lights) ||
    input.quality.maximum_shadowed_lights <= 0
  ) {
    throw new Error(
      `maximum shadowed lights ${input.quality.maximum_shadowed_lights} must be a positive safe integer`,
    );
  }
  if (![1, 0.5, 0.25].includes(input.quality.resolution_scale)) {
    throw new Error(
      `shadow resolution scale ${input.quality.resolution_scale} must be 1, 0.5, or 0.25`,
    );
  }
  if (
    !Number.isSafeInteger(input.quality.cached_update_interval_multiplier) ||
    input.quality.cached_update_interval_multiplier <= 0
  ) {
    throw new Error(
      `cached shadow update multiplier ${input.quality.cached_update_interval_multiplier} must be a positive safe integer`,
    );
  }
  for (
    const [field, value] of [
      ["camera revision", input.camera_revision],
      ["caster revision", input.caster_revision],
      ["frame index", input.frame_index],
    ] as const
  ) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(
        `shadow ${field} ${value} must be a nonnegative safe integer`,
      );
    }
  }
  const candidates = input.lights.filter(casts_shadow).sort((left, right) =>
    right.importance - left.importance || left.id.localeCompare(right.id)
  );
  const selected = candidates.slice(0, input.quality.maximum_shadowed_lights);
  const overflow: LightId[] = candidates.slice(
    input.quality.maximum_shadowed_lights,
  ).map(({ id }) => id);
  const cursor: AtlasCursor = { x: 0, y: 0, row_height: 0 };
  const splits = cascade_partitions(
    input.view.projection.near,
    input.view.projection.far,
    input.quality.cascade_count,
    input.quality.cascade_lambda,
  );
  const views: ShadowView[] = [];
  const invalidations: ShadowInvalidation[] = [];
  const cache = new Map<LightId, ShadowCacheEntry>();
  const signature = JSON.stringify(input.quality);
  for (const light of selected) {
    const count = view_count(light, input.quality.cascade_count);
    let resolution = Math.min(
      light.shadow.resolution * input.quality.resolution_scale,
      input.quality.atlas_size,
    );
    let tiles: readonly ShadowAtlasTile[] | null = null;
    while (resolution >= input.quality.minimum_resolution && tiles === null) {
      tiles = allocate_group(
        cursor,
        count,
        resolution,
        input.quality.atlas_size,
      );
      if (tiles === null) resolution /= 2;
    }
    if (tiles === null) {
      overflow.push(light.id);
      continue;
    }
    views.push(...shadow_views(light, input.view, splits, tiles));
    const decision = invalidation(light, input, signature);
    invalidations.push(Object.freeze(decision));
    const previous = input.previous_cache?.get(light.id);
    cache.set(
      light.id,
      Object.freeze({
        light: light.id,
        light_revision: light.revision,
        caster_revision: input.caster_revision,
        camera_revision: input.camera_revision,
        quality_signature: signature,
        rendered_frame: decision.action === "render"
          ? input.frame_index
          : previous?.rendered_frame ?? input.frame_index,
      }),
    );
  }
  input.observer?.event("lighting.shadows.planned", {
    light_count: selected.length,
    view_count: views.length,
    overflow: overflow.length,
    invalidated: invalidations.filter(({ action }) =>
      action === "render"
    ).length,
  });
  return Object.freeze({
    atlas_size: input.quality.atlas_size,
    views: Object.freeze(views),
    invalidations: Object.freeze(invalidations),
    overflow: Object.freeze(overflow),
    cache,
  });
}
