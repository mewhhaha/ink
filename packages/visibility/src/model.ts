import type { CameraView } from "@ink/camera/view.ts";
import type { Aabb } from "@ink/geometry/shapes.ts";
import type { Vec3 } from "@ink/math/vector.ts";
import type { Observer } from "@ink/observability/observer.ts";
import type { CellId } from "@ink/world/identity.ts";

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
  readonly cell?: CellId;
  readonly maximum_distance?: number;
  readonly minimum_projected_pixels?: number;
  readonly occluder: boolean;
  readonly velocity?: Vec3;
}

export type OcclusionState =
  | { readonly type: "visible"; readonly revision: number }
  | {
    readonly type: "occluded";
    readonly revision: number;
    readonly confidence: "certain" | "reduced";
  }
  | { readonly type: "pending"; readonly revision: number }
  | {
    readonly type: "stale";
    readonly revision: number;
    readonly expected_revision: number;
  }
  | {
    readonly type: "unavailable";
    readonly revision: number;
    readonly reason: string;
  }
  | {
    readonly type: "invalidated";
    readonly revision: number;
    readonly reason: string;
  };

export interface VisibilityPolicy {
  readonly lod_hysteresis_ratio: number;
  readonly motion_expansion_seconds: number;
  readonly maximum_portal_depth: number;
}

export interface VisibilityContext {
  readonly revision: number;
  readonly views: readonly CameraView[];
  readonly policy: VisibilityPolicy;
  readonly allowed_cells?: ReadonlySet<CellId>;
  readonly occlusion?: ReadonlyMap<VisibilityId, OcclusionState>;
  readonly previous?: VisibleSet;
  readonly camera_cut?: true;
  readonly observer?: Observer;
}

export type RejectionReason =
  | "layer"
  | "world_partition"
  | "distance"
  | "frustum"
  | "projected_size"
  | "occlusion";

export interface VisibleRecord {
  readonly id: VisibilityId;
  readonly source_revision: number;
  readonly views: readonly string[];
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
  const parsed = value.trim();
  if (parsed.length === 0) {
    throw new Error(`visibility id ${JSON.stringify(value)} cannot be empty`);
  }
  return parsed as VisibilityId;
}

export function visibility_object(value: VisibilityObject): VisibilityObject {
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
  const lods = [...value.lods].sort((left, right) =>
    right.minimum_projected_pixels - left.minimum_projected_pixels ||
    left.id.localeCompare(right.id)
  );
  if (lods.length === 0) {
    throw new Error(
      `visibility object ${JSON.stringify(value.id)} needs at least one LOD`,
    );
  }
  const ids = new Set<string>();
  for (const lod of lods) {
    if (lod.id.trim().length === 0 || ids.has(lod.id)) {
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
  return Object.freeze({ ...value, layers: value.layers >>> 0, lods });
}
