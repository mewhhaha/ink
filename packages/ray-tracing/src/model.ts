import type { Aabb } from "@ink/geometry/shapes.ts";
import type { MeshTopology } from "@ink/geometry/mesh.ts";
import type { LightDefinition } from "@ink/lighting/light.ts";
import type { CanonicalMaterialRecord } from "@ink/materials/canonical.ts";
import type { Mat4 } from "@ink/math/matrix.ts";
import type { Vec2, Vec3 } from "@ink/math/vector.ts";
import type {
  RayTracingGeometryId,
  RayTracingInstanceId,
  RayTracingSampleSequence,
  RayTracingSceneRevision,
} from "./identity.ts";

export type RayTracingMaterialIdentity =
  | {
    readonly type: "definition";
    readonly id: CanonicalMaterialRecord["definition"];
  }
  | {
    readonly type: "instance";
    readonly id: NonNullable<CanonicalMaterialRecord["instance"]>;
  };

export interface IndexedRayTracingGeometry {
  readonly id: RayTracingGeometryId;
  readonly revision: number;
  readonly topology: MeshTopology;
  readonly vertex_normals: readonly Vec3[] | null;
  readonly material: RayTracingMaterialIdentity;
}

export interface ResolvedRayTracingInstance {
  readonly id: RayTracingInstanceId;
  readonly revision: number;
  readonly geometry: RayTracingGeometryId;
  readonly transform: Mat4;
}

export interface RayTracingSceneInput {
  readonly revision: RayTracingSceneRevision;
  readonly geometries: readonly IndexedRayTracingGeometry[];
  readonly instances: readonly ResolvedRayTracingInstance[];
  readonly materials: readonly CanonicalMaterialRecord[];
  readonly lights: readonly LightDefinition[];
}

export interface RayTracingBuildLimits {
  readonly maximum_triangles: number;
  readonly maximum_materials: number;
  readonly maximum_lights: number;
  readonly maximum_instances: number;
  readonly maximum_blas_nodes: number;
  readonly maximum_tlas_nodes: number;
}

export interface PackedRayTracingMaterial {
  readonly identity: RayTracingMaterialIdentity;
  readonly record: CanonicalMaterialRecord;
}

export interface PackedRayTracingTriangle {
  readonly geometry: RayTracingGeometryId;
  readonly source_triangle: number;
  readonly material_index: number;
  readonly a: Vec3;
  readonly b: Vec3;
  readonly c: Vec3;
  readonly texture_coordinates: readonly [Vec2, Vec2, Vec2] | null;
  readonly vertex_normals: readonly [Vec3, Vec3, Vec3] | null;
}

export type PackedRayTracingBvhNode =
  | {
    readonly type: "branch";
    readonly bounds: Aabb;
    readonly left: number;
    readonly right: number;
    readonly escape: number;
  }
  | {
    readonly type: "leaf";
    readonly bounds: Aabb;
    readonly first_index: number;
    readonly index_count: number;
    readonly escape: number;
  };

export interface PackedRayTracingBlas {
  readonly nodes: readonly PackedRayTracingBvhNode[];
  readonly indices: readonly number[];
  readonly root: number;
}

export interface PackedRayTracingGeometry {
  readonly id: RayTracingGeometryId;
  readonly revision: number;
  readonly first_triangle: number;
  readonly triangle_count: number;
  readonly bounds: Aabb;
  readonly blas_root: number;
  readonly blas: PackedRayTracingBlas;
}

export interface PackedRayTracingInstance {
  readonly id: RayTracingInstanceId;
  readonly revision: number;
  readonly geometry_index: number;
  readonly transform: Mat4;
  readonly inverse_transform: Mat4;
  readonly bounds: Aabb;
}

export interface PackedRayTracingScene {
  readonly revision: RayTracingSceneRevision;
  readonly geometries: readonly PackedRayTracingGeometry[];
  readonly instances: readonly PackedRayTracingInstance[];
  readonly triangles: readonly PackedRayTracingTriangle[];
  readonly materials: readonly PackedRayTracingMaterial[];
  readonly lights: readonly LightDefinition[];
  readonly blas: readonly PackedRayTracingBvhNode[];
  readonly blas_indices: readonly number[];
  readonly tlas: readonly PackedRayTracingBvhNode[];
  readonly tlas_indices: readonly number[];
  readonly tlas_root: number | null;
}

export type RayTracingAccelerationUpdate =
  | { readonly type: "unchanged" }
  | { readonly type: "rebuild_tlas" }
  | {
    readonly type: "rebuild_blas_and_tlas";
    readonly geometries: readonly [
      RayTracingGeometryId,
      ...RayTracingGeometryId[],
    ];
  };

export interface RayTracingBarycentrics {
  readonly a: number;
  readonly b: number;
  readonly c: number;
}

export interface RayTracingHit {
  readonly distance: number;
  readonly position: Vec3;
  readonly normal: Vec3;
  readonly front_face: boolean;
  readonly barycentrics: RayTracingBarycentrics;
  readonly texture_coordinate: Vec2 | null;
  readonly geometry: RayTracingGeometryId;
  readonly instance: RayTracingInstanceId;
  readonly material: RayTracingMaterialIdentity;
  readonly source_triangle: number;
}

export interface PathTracingQuality {
  readonly samples_per_frame: number;
  readonly maximum_bounces: number;
  readonly render_scale: number;
  readonly denoiser: "edge_aware";
}

export interface PathTracingPresentationState {
  readonly scene_revision: RayTracingSceneRevision;
  readonly transform_revision: number;
  readonly material_revision: number;
  readonly light_revision: number;
  readonly camera_revision: number;
  readonly viewport: {
    readonly width: number;
    readonly height: number;
  };
  readonly exposure_revision: number;
  readonly fog_revision: number;
  readonly quality: PathTracingQuality;
}

export type PathTracingAccumulationResetReason =
  | "initial"
  | "scene"
  | "transforms"
  | "materials"
  | "lights"
  | "camera"
  | "viewport"
  | "exposure"
  | "fog"
  | "quality";

interface PathTracingFrameBase {
  readonly presentation: PathTracingPresentationState;
  readonly sample_sequence: RayTracingSampleSequence;
  readonly samples_in_frame: number;
  readonly accumulated_samples: number;
}

export type PathTracingFrame =
  | (PathTracingFrameBase & {
    readonly type: "reset";
    readonly reasons: readonly [
      PathTracingAccumulationResetReason,
      ...PathTracingAccumulationResetReason[],
    ];
  })
  | (PathTracingFrameBase & { readonly type: "continued" });

export const ray_tracing_missing_node = 0xffff_ffff;

export function ray_tracing_material_identity(
  record: CanonicalMaterialRecord,
): RayTracingMaterialIdentity {
  return record.instance === undefined
    ? Object.freeze({ type: "definition", id: record.definition })
    : Object.freeze({ type: "instance", id: record.instance });
}
