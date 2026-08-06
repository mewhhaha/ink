import type { AssetId } from "@ink/assets/identity.ts";
import type { Aabb } from "@ink/geometry/shapes.ts";
import type { LinearRgb } from "@ink/materials/color.ts";
import type { Vec2, Vec3 } from "@ink/math/vector.ts";
import type { SceneNodeId } from "@ink/scene/identity.ts";
import type { EnvironmentId, LightId, ProbeId } from "./identity.ts";

export type ShadowFilter =
  | { readonly type: "pcf"; readonly radius: 1 | 2 | 3 }
  | { readonly type: "variance"; readonly minimum_variance: number };

export type ShadowPolicy =
  | { readonly type: "off" }
  | {
    readonly type: "dynamic" | "cached";
    readonly resolution: 128 | 256 | 512 | 1024 | 2048 | 4096;
    readonly depth_bias: number;
    readonly normal_bias: number;
    readonly filter: ShadowFilter;
    readonly update_interval_frames: number;
  };

interface LightBase {
  readonly id: LightId;
  readonly revision: number;
  readonly color: LinearRgb;
  readonly layers: number;
  readonly importance: number;
  readonly shadow: ShadowPolicy;
  readonly scene_node?: SceneNodeId;
}

export type LightDefinition =
  | (LightBase & {
    readonly type: "directional";
    readonly direction: Vec3;
    readonly illuminance_lux: number;
    readonly angular_diameter_radians: number;
  })
  | (LightBase & {
    readonly type: "point";
    readonly position: Vec3;
    readonly intensity_candela: number;
    readonly range: number;
    readonly source_radius: number;
  })
  | (LightBase & {
    readonly type: "spot";
    readonly position: Vec3;
    readonly direction: Vec3;
    readonly intensity_candela: number;
    readonly range: number;
    readonly inner_angle_radians: number;
    readonly outer_angle_radians: number;
    readonly source_radius: number;
  })
  | (LightBase & {
    readonly type: "rectangular";
    readonly position: Vec3;
    readonly normal: Vec3;
    readonly tangent: Vec3;
    readonly size: Vec2;
    readonly luminance_nits: number;
    readonly range: number;
    readonly two_sided: boolean;
  })
  | (LightBase & {
    readonly type: "environment";
    readonly environment: EnvironmentId;
    readonly intensity: number;
    readonly rotation_radians: number;
    readonly priority: number;
  });

export interface ClusterQuality {
  readonly x_slices: number;
  readonly y_slices: number;
  readonly z_slices: number;
  readonly maximum_lights_per_cluster: number;
}

export interface ShadowQuality {
  readonly atlas_size: 1024 | 2048 | 4096 | 8192;
  readonly cascade_count: 1 | 2 | 3 | 4;
  readonly cascade_lambda: number;
  readonly minimum_resolution: 128 | 256 | 512;
  readonly maximum_shadowed_lights: number;
  readonly resolution_scale: 1 | 0.5 | 0.25;
  readonly cached_update_interval_multiplier: number;
}

export interface LightingQuality {
  readonly clusters: ClusterQuality;
  readonly shadows: ShadowQuality;
  readonly maximum_lights: number;
  readonly maximum_probes: number;
  readonly environment_roughness_levels: number;
}

export type ExposureInput =
  | { readonly type: "manual"; readonly ev100: number }
  | {
    readonly type: "automatic";
    readonly minimum_ev100: number;
    readonly maximum_ev100: number;
    readonly compensation_ev: number;
    readonly brighten_speed: number;
    readonly darken_speed: number;
  };

export interface AtmosphereInput {
  readonly planet_center: Vec3;
  readonly planet_radius: number;
  readonly atmosphere_height: number;
  readonly rayleigh_scattering: LinearRgb;
  readonly mie_scattering: LinearRgb;
  readonly mie_anisotropy: number;
  readonly ground_albedo: LinearRgb;
  readonly sun: LightId;
}

export interface IrradianceProbe {
  readonly id: ProbeId;
  readonly revision: number;
  readonly volume: Aabb;
  readonly priority: number;
  readonly blend_distance: number;
  readonly spherical_harmonics: readonly Vec3[];
}

export interface ReflectionProbe {
  readonly id: ProbeId;
  readonly revision: number;
  readonly volume: Aabb;
  readonly priority: number;
  readonly blend_distance: number;
  readonly environment: EnvironmentId;
}

export interface LightMap {
  readonly texture: AssetId<"texture">;
  readonly revision: number;
  readonly uv_set: number;
  readonly intensity: number;
  readonly directional: boolean;
}

export interface EnvironmentSource {
  readonly id: EnvironmentId;
  readonly revision: number;
  readonly asset?: AssetId<"environment">;
  readonly width: number;
  readonly height: number;
  readonly pixels: readonly LinearRgb[];
}

export interface PrefilteredEnvironment {
  readonly id: EnvironmentId;
  readonly revision: number;
  readonly irradiance_sh: readonly Vec3[];
  readonly reflection_levels: readonly {
    readonly roughness: number;
    readonly axis_radiance: readonly LinearRgb[];
  }[];
  readonly split_sum_lut: {
    readonly resolution: number;
    readonly sample_count: number;
  };
}

export interface QualityReduction {
  readonly field: string;
  readonly from: number;
  readonly to: number;
}
