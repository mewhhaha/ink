import { type CameraView, world_to_screen } from "@ink/camera/view.ts";
import { vec3 } from "@ink/math/vector.ts";
import {
  type OcclusionState,
  type VisibilityId,
  type VisibilityObject,
} from "./model.ts";

export interface OcclusionRasterExtent {
  readonly width: number;
  readonly height: number;
}

export interface OcclusionInput {
  readonly input_revision: number;
  readonly view: CameraView;
  readonly raster: OcclusionRasterExtent;
  readonly occluders: readonly VisibilityObject[];
  readonly objects: readonly VisibilityObject[];
}

export interface OcclusionBatch {
  readonly input_revision: number;
  readonly states: ReadonlyMap<VisibilityId, OcclusionState>;
}

interface ProjectedRectangle {
  readonly minimum_x: number;
  readonly maximum_x: number;
  readonly minimum_y: number;
  readonly maximum_y: number;
  readonly nearest_depth: number;
  readonly farthest_depth: number;
}

export function software_occlusion(input: OcclusionInput): OcclusionBatch {
  validate_input(input);
  const pixel_count = input.raster.width * input.raster.height;
  const reversed = input.view.projection.depth === "reversed";
  const uncovered = reversed ? 0 : 1;
  const depth = new Float64Array(pixel_count);
  depth.fill(uncovered);
  const coverage = new Uint8Array(pixel_count);
  const occluder_ids = new Set(input.occluders.map((object) => object.id));

  for (
    const object of [...input.occluders].sort((left, right) =>
      left.id.localeCompare(right.id)
    )
  ) {
    const rectangle = project_bounds(object, input.view, input.raster);
    if (rectangle === undefined) continue;
    rasterize_rectangle(rectangle, input.raster, (index) => {
      const value = rectangle.farthest_depth;
      if (!coverage[index]) depth[index] = value;
      else {depth[index] = reversed
          ? Math.max(depth[index], value)
          : Math.min(depth[index], value);}
      coverage[index] = 1;
    });
  }

  const full_resolution =
    input.raster.width >= Math.ceil(input.view.viewport.width) &&
    input.raster.height >= Math.ceil(input.view.viewport.height);
  const states = new Map<VisibilityId, OcclusionState>();
  for (
    const object of [...input.objects].sort((left, right) =>
      left.id.localeCompare(right.id)
    )
  ) {
    if (occluder_ids.has(object.id)) {
      states.set(object.id, {
        type: "visible",
        revision: input.input_revision,
      });
      continue;
    }
    const rectangle = project_bounds(object, input.view, input.raster);
    if (rectangle === undefined) {
      states.set(object.id, {
        type: "visible",
        revision: input.input_revision,
      });
      continue;
    }
    let hidden = true;
    rasterize_rectangle(rectangle, input.raster, (index) => {
      if (!hidden) return;
      if (!coverage[index]) {
        hidden = false;
        return;
      }
      const epsilon = 1e-8;
      const behind = reversed
        ? rectangle.nearest_depth < depth[index] - epsilon
        : rectangle.nearest_depth > depth[index] + epsilon;
      if (!behind) hidden = false;
    });
    states.set(
      object.id,
      hidden
        ? {
          type: "occluded",
          revision: input.input_revision,
          confidence: full_resolution ? "certain" : "reduced",
        }
        : { type: "visible", revision: input.input_revision },
    );
  }
  return { input_revision: input.input_revision, states };
}

export function ingest_occlusion_batch(
  batch: OcclusionBatch,
  expected_revision: number,
  options: { readonly camera_cut?: true } = {},
): ReadonlyMap<VisibilityId, OcclusionState> {
  const result = new Map<VisibilityId, OcclusionState>();
  for (const [id, state] of batch.states) {
    if (options.camera_cut === true) {
      result.set(id, {
        type: "invalidated",
        revision: batch.input_revision,
        reason: "camera cut",
      });
    } else if (batch.input_revision !== expected_revision) {
      result.set(id, {
        type: "stale",
        revision: batch.input_revision,
        expected_revision,
      });
    } else {
      result.set(id, state);
    }
  }
  return result;
}

function project_bounds(
  object: VisibilityObject,
  view: CameraView,
  raster: OcclusionRasterExtent,
): ProjectedRectangle | undefined {
  const bounds = object.bounds;
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
  if (corners.some((corner) => corner.type !== "ready")) return undefined;
  const points = corners.map((corner) =>
    corner.type === "ready" ? corner.value : vec3(0, 0, 0)
  );
  if (points.some((point) => point.z < 0 || point.z > 1)) return undefined;
  const scale_x = raster.width / view.viewport.width;
  const scale_y = raster.height / view.viewport.height;
  const xs = points.map((point) => (point.x - view.viewport.x) * scale_x);
  const ys = points.map((point) => (point.y - view.viewport.y) * scale_y);
  const depths = points.map((point) => point.z);
  const reversed = view.projection.depth === "reversed";
  return {
    minimum_x: Math.max(0, Math.floor(Math.min(...xs))),
    maximum_x: Math.min(raster.width - 1, Math.ceil(Math.max(...xs))),
    minimum_y: Math.max(0, Math.floor(Math.min(...ys))),
    maximum_y: Math.min(raster.height - 1, Math.ceil(Math.max(...ys))),
    nearest_depth: reversed ? Math.max(...depths) : Math.min(...depths),
    farthest_depth: reversed ? Math.min(...depths) : Math.max(...depths),
  };
}

function rasterize_rectangle(
  rectangle: ProjectedRectangle,
  raster: OcclusionRasterExtent,
  visit: (index: number) => void,
): void {
  if (
    rectangle.minimum_x > rectangle.maximum_x ||
    rectangle.minimum_y > rectangle.maximum_y
  ) return;
  for (let y = rectangle.minimum_y; y <= rectangle.maximum_y; y += 1) {
    for (let x = rectangle.minimum_x; x <= rectangle.maximum_x; x += 1) {
      visit(y * raster.width + x);
    }
  }
}

function validate_input(input: OcclusionInput): void {
  if (!Number.isSafeInteger(input.input_revision) || input.input_revision < 0) {
    throw new Error(
      `occlusion revision ${
        JSON.stringify(input.input_revision)
      } must be nonnegative`,
    );
  }
  for (const [field, value] of Object.entries(input.raster)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(
        `occlusion raster ${field} ${JSON.stringify(value)} must be positive`,
      );
    }
  }
  if (input.raster.width * input.raster.height > 16_777_216) {
    throw new Error(
      `occlusion raster ${input.raster.width}x${input.raster.height} exceeds 16777216 pixels`,
    );
  }
}
