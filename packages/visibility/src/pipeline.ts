import { world_to_screen } from "@ink/camera/view.ts";
import { frustum_contains_aabb } from "@ink/geometry/frustum.ts";
import { closest_point_on_aabb } from "@ink/geometry/queries.ts";
import { type Aabb, aabb_center } from "@ink/geometry/shapes.ts";
import { vec3, vec3_length, vec3_subtract } from "@ink/math/vector.ts";
import {
  type RejectedRecord,
  type RejectionReason,
  visibility_object,
  type VisibilityContext,
  type VisibilityId,
  type VisibilityLod,
  type VisibilityObject,
  type VisibleRecord,
  type VisibleSet,
} from "./model.ts";

export class VisibilityPipeline {
  evaluate(
    objects: readonly VisibilityObject[],
    context: VisibilityContext,
  ): VisibleSet {
    validate_context(context);
    const ids = new Set<VisibilityId>();
    const visible: VisibleRecord[] = [];
    const rejected: RejectedRecord[] = [];
    for (
      const object of objects.map(visibility_object).sort((left, right) =>
        compare_code_units(left.id, right.id)
      )
    ) {
      if (ids.has(object.id)) {
        throw new Error(
          `visibility input revision ${context.revision} repeats object ${
            JSON.stringify(object.id)
          }`,
        );
      }
      ids.add(object.id);
      const view = context.view;
      if (((view.layers & object.layers) >>> 0) === 0) {
        rejected.push(rejection(object, "layer"));
        continue;
      }
      if (object.maximum_distance !== undefined) {
        const nearest = closest_point_on_aabb(
          view.pose.position,
          object.bounds,
        );
        if (
          vec3_length(vec3_subtract(nearest, view.pose.position)) >
            object.maximum_distance
        ) {
          rejected.push(rejection(object, "distance"));
          continue;
        }
      }
      if (
        frustum_contains_aabb(view.culling_frustum, object.bounds) === "outside"
      ) {
        rejected.push(rejection(object, "frustum"));
        continue;
      }
      const pixels = projected_size(object.bounds, view);
      if (
        object.minimum_projected_pixels !== undefined &&
        pixels < object.minimum_projected_pixels
      ) {
        rejected.push(rejection(object, "projected_size"));
        continue;
      }
      const previous_lod = context.previous?.visible.find((entry) =>
        entry.id === object.id
      )?.lod;
      visible.push(Object.freeze({
        id: object.id,
        source_revision: object.revision,
        lod: select_lod(
          object.lods,
          pixels,
          previous_lod,
          context.lod_hysteresis_ratio,
        ),
        projected_pixels: pixels,
      }));
    }
    const result = Object.freeze({
      input_revision: context.revision,
      visible: Object.freeze(visible),
      rejected: Object.freeze(rejected),
    });
    return result;
  }
}

export function select_lod(
  lods: readonly VisibilityLod[],
  projected_pixels: number,
  previous: string | undefined,
  hysteresis_ratio: number,
): string {
  if (!Number.isFinite(projected_pixels) || projected_pixels < 0) {
    throw new Error(
      `projected size ${
        JSON.stringify(projected_pixels)
      } must be finite and nonnegative`,
    );
  }
  if (
    !Number.isFinite(hysteresis_ratio) || hysteresis_ratio < 0 ||
    hysteresis_ratio >= 1
  ) {
    throw new Error(
      `LOD hysteresis ${JSON.stringify(hysteresis_ratio)} must be in 0..<1`,
    );
  }
  const ordered = lods.map((lod) => ({
    ...lod,
    id: typeof lod.id === "string" ? lod.id.trim() : lod.id,
  })).sort((left, right) =>
    right.minimum_projected_pixels - left.minimum_projected_pixels ||
    compare_code_units(String(left.id), String(right.id))
  );
  if (ordered.length === 0) {
    throw new Error("LOD selection requires at least one level");
  }
  const ids = new Set<string>();
  for (const lod of ordered) {
    if (
      typeof lod.id !== "string" || lod.id.trim().length === 0 ||
      ids.has(lod.id)
    ) {
      throw new Error(
        `LOD selection has invalid or duplicate level ${
          JSON.stringify(lod.id)
        }`,
      );
    }
    if (
      !Number.isFinite(lod.minimum_projected_pixels) ||
      lod.minimum_projected_pixels < 0
    ) {
      throw new Error(
        `LOD ${JSON.stringify(lod.id)} threshold ${
          JSON.stringify(lod.minimum_projected_pixels)
        } must be finite and nonnegative`,
      );
    }
    ids.add(lod.id);
  }
  const selected =
    ordered.find((lod) => projected_pixels >= lod.minimum_projected_pixels) ??
      ordered.at(-1)!;
  const previous_lod = ordered.find((lod) => lod.id === previous);
  if (previous_lod === undefined || previous_lod.id === selected.id) {
    return selected.id;
  }
  const previous_index = ordered.indexOf(previous_lod);
  const selected_index = ordered.indexOf(selected);
  if (selected_index < previous_index) {
    return projected_pixels >=
        selected.minimum_projected_pixels * (1 + hysteresis_ratio)
      ? selected.id
      : previous_lod.id;
  }
  return projected_pixels >=
      previous_lod.minimum_projected_pixels * (1 - hysteresis_ratio)
    ? previous_lod.id
    : selected.id;
}

function projected_size(
  bounds: Aabb,
  view: VisibilityContext["view"],
): number {
  const corners = [
    vec3(bounds.minimum.x, bounds.minimum.y, bounds.minimum.z),
    vec3(bounds.minimum.x, bounds.minimum.y, bounds.maximum.z),
    vec3(bounds.minimum.x, bounds.maximum.y, bounds.minimum.z),
    vec3(bounds.minimum.x, bounds.maximum.y, bounds.maximum.z),
    vec3(bounds.maximum.x, bounds.minimum.y, bounds.minimum.z),
    vec3(bounds.maximum.x, bounds.minimum.y, bounds.maximum.z),
    vec3(bounds.maximum.x, bounds.maximum.y, bounds.minimum.z),
    vec3(bounds.maximum.x, bounds.maximum.y, bounds.maximum.z),
  ].map((corner) => world_to_screen(view, corner));
  if (corners.some((corner) => corner.type === "conversion_failed")) {
    return Math.max(view.viewport.width, view.viewport.height);
  }
  const points = corners.map((corner) =>
    corner.type === "ready" ? corner.value : aabb_center(bounds)
  );
  return Math.max(
    Math.max(...points.map((point) => point.x)) -
      Math.min(...points.map((point) => point.x)),
    Math.max(...points.map((point) => point.y)) -
      Math.min(...points.map((point) => point.y)),
  );
}

function rejection(
  object: VisibilityObject,
  reason: RejectionReason,
): RejectedRecord {
  return Object.freeze({
    id: object.id,
    source_revision: object.revision,
    reason,
  });
}

function validate_context(context: VisibilityContext): void {
  if (!Number.isSafeInteger(context.revision) || context.revision < 0) {
    throw new Error(
      `visibility revision ${
        JSON.stringify(context.revision)
      } must be nonnegative`,
    );
  }
  if (
    !Number.isFinite(context.lod_hysteresis_ratio) ||
    context.lod_hysteresis_ratio < 0 || context.lod_hysteresis_ratio >= 1
  ) {
    throw new Error(
      `visibility LOD hysteresis ${
        JSON.stringify(context.lod_hysteresis_ratio)
      } must be in 0..<1`,
    );
  }
}

function compare_code_units(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
