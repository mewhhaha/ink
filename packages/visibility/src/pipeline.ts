import { world_to_screen } from "@ink/camera/view.ts";
import { frustum_contains_aabb } from "@ink/geometry/frustum.ts";
import { closest_point_on_aabb } from "@ink/geometry/queries.ts";
import { type Aabb, aabb, aabb_center } from "@ink/geometry/shapes.ts";
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

interface ViewAcceptance {
  readonly type: "visible";
  readonly view: string;
  readonly projected_pixels: number;
}

interface ViewRejection {
  readonly type: "rejected";
  readonly reason: RejectionReason;
}

const rejection_rank: Readonly<Record<RejectionReason, number>> = {
  layer: 0,
  world_partition: 1,
  distance: 2,
  frustum: 3,
  projected_size: 4,
  occlusion: 5,
};

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
        left.id.localeCompare(right.id)
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
      if (
        object.cell !== undefined && context.allowed_cells !== undefined &&
        !context.allowed_cells.has(object.cell)
      ) {
        rejected.push(rejection(object, "world_partition"));
        continue;
      }
      const bounds = expanded_bounds(
        object,
        context.policy.motion_expansion_seconds,
      );
      const view_results = context.views.map(
        (view): ViewAcceptance | ViewRejection => {
          if (((view.layers & object.layers) >>> 0) === 0) {
            return { type: "rejected", reason: "layer" };
          }
          if (object.maximum_distance !== undefined) {
            const nearest = closest_point_on_aabb(view.pose.position, bounds);
            if (
              vec3_length(vec3_subtract(nearest, view.pose.position)) >
                object.maximum_distance
            ) {
              return { type: "rejected", reason: "distance" };
            }
          }
          if (
            frustum_contains_aabb(view.culling_frustum, bounds) === "outside"
          ) {
            return { type: "rejected", reason: "frustum" };
          }
          const pixels = projected_size(bounds, view);
          if (
            object.minimum_projected_pixels !== undefined &&
            pixels < object.minimum_projected_pixels
          ) {
            return { type: "rejected", reason: "projected_size" };
          }
          return {
            type: "visible",
            view: view.camera,
            projected_pixels: pixels,
          };
        },
      );
      const accepted = view_results.filter((result): result is ViewAcceptance =>
        result.type === "visible"
      );
      if (accepted.length === 0) {
        const reasons = view_results.filter((result): result is ViewRejection =>
          result.type === "rejected"
        );
        reasons.sort((left, right) =>
          rejection_rank[left.reason] - rejection_rank[right.reason]
        );
        rejected.push(rejection(object, reasons[0]?.reason ?? "frustum"));
        continue;
      }
      if (is_certainly_occluded(object, context)) {
        rejected.push(rejection(object, "occlusion"));
        continue;
      }
      const pixels = Math.max(
        ...accepted.map((entry) => entry.projected_pixels),
      );
      const previous_lod = context.previous?.visible.find((entry) =>
        entry.id === object.id
      )?.lod;
      visible.push(Object.freeze({
        id: object.id,
        source_revision: object.revision,
        views: Object.freeze(accepted.map((entry) => entry.view).sort()),
        lod: select_lod(
          object.lods,
          pixels,
          previous_lod,
          context.policy.lod_hysteresis_ratio,
        ),
        projected_pixels: pixels,
      }));
    }
    const result = Object.freeze({
      input_revision: context.revision,
      visible: Object.freeze(visible),
      rejected: Object.freeze(rejected),
    });
    context.observer?.event("visibility.evaluated", {
      input_revision: context.revision,
      candidates: objects.length,
      visible: visible.length,
      rejected: rejected.length,
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
    String(left.id).localeCompare(String(right.id))
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

function is_certainly_occluded(
  object: VisibilityObject,
  context: VisibilityContext,
): boolean {
  if (context.camera_cut || context.occlusion === undefined) return false;
  if (object.velocity !== undefined && vec3_length(object.velocity) > 0) {
    return false;
  }
  if (!context.previous?.visible.some((entry) => entry.id === object.id)) {
    return false;
  }
  const state = context.occlusion.get(object.id);
  return state?.type === "occluded" && state.confidence === "certain" &&
    state.revision === context.revision;
}

function expanded_bounds(object: VisibilityObject, seconds: number): Aabb {
  if (object.velocity === undefined || seconds === 0) return object.bounds;
  const displacement = vec3(
    Math.abs(object.velocity.x * seconds),
    Math.abs(object.velocity.y * seconds),
    Math.abs(object.velocity.z * seconds),
  );
  return aabb(
    vec3(
      object.bounds.minimum.x - displacement.x,
      object.bounds.minimum.y - displacement.y,
      object.bounds.minimum.z - displacement.z,
    ),
    vec3(
      object.bounds.maximum.x + displacement.x,
      object.bounds.maximum.y + displacement.y,
      object.bounds.maximum.z + displacement.z,
    ),
  );
}

function projected_size(
  bounds: Aabb,
  view: VisibilityContext["views"][number],
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
  if (context.views.length === 0) {
    throw new Error("visibility context needs at least one camera view");
  }
  const cameras = new Set<string>();
  for (const view of context.views) {
    if (cameras.has(view.camera)) {
      throw new Error(
        `visibility context repeats camera view ${JSON.stringify(view.camera)}`,
      );
    }
    cameras.add(view.camera);
  }
  if (
    !Number.isFinite(context.policy.lod_hysteresis_ratio) ||
    context.policy.lod_hysteresis_ratio < 0 ||
    context.policy.lod_hysteresis_ratio >= 1
  ) {
    throw new Error(
      `visibility LOD hysteresis ${
        JSON.stringify(context.policy.lod_hysteresis_ratio)
      } must be in 0..<1`,
    );
  }
  if (
    !Number.isFinite(context.policy.motion_expansion_seconds) ||
    context.policy.motion_expansion_seconds < 0
  ) {
    throw new Error(
      `visibility motion expansion ${
        JSON.stringify(context.policy.motion_expansion_seconds)
      } must be nonnegative`,
    );
  }
  if (
    !Number.isSafeInteger(context.policy.maximum_portal_depth) ||
    context.policy.maximum_portal_depth < 0
  ) {
    throw new Error(
      `visibility portal depth ${
        JSON.stringify(context.policy.maximum_portal_depth)
      } must be nonnegative`,
    );
  }
}
