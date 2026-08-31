import type { CameraView } from "@ink/camera/view.ts";
import { type Aabb, aabb } from "@ink/geometry/shapes.ts";
import { vec3 } from "@ink/math/vector.ts";

declare const visibility_id_brand: unique symbol;
export type VisibilityId = string & { readonly [visibility_id_brand]: true };

export interface VisibilityLod {
  readonly id: string;
  readonly minimum_projected_pixels: number;
}

export interface VisibilityObject {
  readonly id: VisibilityId;
  readonly bounds: Aabb;
  readonly layers: number;
  readonly revision: number;
  readonly lods: readonly VisibilityLod[];
  readonly maximum_distance?: number;
  readonly minimum_projected_pixels?: number;
}

export interface VisibilityContext {
  readonly revision: number;
  readonly view: CameraView;
  readonly lod_hysteresis_ratio: number;
  readonly previous?: VisibleSet;
}

export type RejectionReason =
  | "layer"
  | "distance"
  | "frustum"
  | "projected_size";

export interface VisibleRecord {
  readonly id: VisibilityId;
  readonly source_revision: number;
  readonly lod: string;
  readonly projected_pixels: number;
}

export interface RejectedRecord {
  readonly id: VisibilityId;
  readonly source_revision: number;
  readonly reason: RejectionReason;
}

export interface VisibleSet {
  readonly input_revision: number;
  readonly visible: readonly VisibleRecord[];
  readonly rejected: readonly RejectedRecord[];
}

export function visibility_id(value: string): VisibilityId {
  if (typeof value !== "string") {
    throw new Error(`visibility id ${JSON.stringify(value)} must be a string`);
  }
  const parsed = value.trim();
  if (parsed.length === 0) {
    throw new Error(`visibility id ${JSON.stringify(value)} cannot be empty`);
  }
  return parsed as VisibilityId;
}

export function visibility_object(value: VisibilityObject): VisibilityObject {
  const id = visibility_id(value.id);
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw new Error(
      `visibility object ${JSON.stringify(value.id)} revision ${
        JSON.stringify(value.revision)
      } must be nonnegative`,
    );
  }
  if (
    !Number.isSafeInteger(value.layers) || value.layers < 0 ||
    value.layers > 0xffff_ffff
  ) {
    throw new Error(
      `visibility object ${JSON.stringify(value.id)} layers ${
        JSON.stringify(value.layers)
      } must be unsigned 32-bit`,
    );
  }
  if (!Array.isArray(value.lods)) {
    throw new Error(
      `visibility object ${JSON.stringify(id)} LODs must be an array`,
    );
  }
  const lods = value.lods.map((lod, index) => {
    if (typeof lod.id !== "string") {
      throw new Error(
        `visibility object ${
          JSON.stringify(id)
        } LOD ${index} id must be a string`,
      );
    }
    return { ...lod, id: lod.id.trim() };
  }).sort((left, right) =>
    right.minimum_projected_pixels - left.minimum_projected_pixels ||
    compare_code_units(left.id, right.id)
  );
  if (lods.length === 0) {
    throw new Error(
      `visibility object ${JSON.stringify(value.id)} needs at least one LOD`,
    );
  }
  const ids = new Set<string>();
  for (const lod of lods) {
    if (lod.id.length === 0 || ids.has(lod.id)) {
      throw new Error(
        `visibility object ${
          JSON.stringify(value.id)
        } has invalid or duplicate LOD ${JSON.stringify(lod.id)}`,
      );
    }
    if (
      !Number.isFinite(lod.minimum_projected_pixels) ||
      lod.minimum_projected_pixels < 0
    ) {
      throw new Error(
        `visibility object ${JSON.stringify(value.id)} LOD ${
          JSON.stringify(lod.id)
        } threshold ${
          JSON.stringify(lod.minimum_projected_pixels)
        } must be finite and nonnegative`,
      );
    }
    ids.add(lod.id);
  }
  for (
    const [label, amount] of [
      ["maximum distance", value.maximum_distance],
      ["minimum projected pixels", value.minimum_projected_pixels],
    ] as const
  ) {
    if (amount !== undefined && (!Number.isFinite(amount) || amount < 0)) {
      throw new Error(
        `visibility object ${JSON.stringify(value.id)} ${label} ${
          JSON.stringify(amount)
        } must be finite and nonnegative`,
      );
    }
  }
  const bounds = aabb(
    vec3(
      value.bounds.minimum.x,
      value.bounds.minimum.y,
      value.bounds.minimum.z,
    ),
    vec3(
      value.bounds.maximum.x,
      value.bounds.maximum.y,
      value.bounds.maximum.z,
    ),
  );
  return Object.freeze({
    ...value,
    id,
    bounds,
    layers: value.layers >>> 0,
    lods: Object.freeze(lods.map((lod) => Object.freeze(lod))),
  });
}

function compare_code_units(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
