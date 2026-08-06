import type { LinearRgb, LinearRgba } from "./color.ts";
import type {
  MaterialDefinitionId,
  MaterialInstanceId,
  MaterialVariantId,
} from "./identity.ts";
import type { TextureBinding, TextureSemantic } from "./texture.ts";

export type MaterialFeature =
  | "alpha_mask"
  | "alpha_blend"
  | "double_sided"
  | "normal_map"
  | "occlusion"
  | "emissive"
  | "clearcoat"
  | "transmission"
  | "volume"
  | "toon"
  | "unlit";

export type AlphaMode =
  | { readonly type: "opaque" }
  | { readonly type: "mask"; readonly cutoff: number }
  | { readonly type: "blend" };
export type Sidedness = "front" | "double";

export interface PbrParameters {
  readonly base_color: LinearRgba;
  readonly metallic: number;
  readonly perceptual_roughness: number;
  readonly specular_level: number;
  readonly specular_tint: LinearRgb;
  readonly normal_scale: number;
  readonly occlusion_strength: number;
  readonly emissive: LinearRgb;
  readonly emissive_strength: number;
  readonly clearcoat: number;
  readonly clearcoat_roughness: number;
  readonly transmission: number;
  readonly thickness: number;
  readonly index_of_refraction: number;
}

export type StylizedExtension =
  | {
    readonly type: "toon";
    readonly bands: number;
    readonly edge_softness: number;
    readonly rim_strength: number;
  }
  | { readonly type: "unlit"; readonly tint: LinearRgb };

export type MaterialParameterOverrides = Partial<PbrParameters>;

export interface MaterialVariant {
  readonly id: MaterialVariantId;
  readonly fallback?: MaterialVariantId;
  readonly required_features: readonly MaterialFeature[];
}

export interface MaterialDefinitionInput {
  readonly id: MaterialDefinitionId;
  readonly revision: number;
  readonly parameters: PbrParameters;
  readonly alpha: AlphaMode;
  readonly sidedness: Sidedness;
  readonly textures?: readonly TextureBinding[];
  readonly stylized?: StylizedExtension;
  readonly variants?: readonly MaterialVariant[];
}

export interface MaterialDefinition extends MaterialDefinitionInput {
  readonly textures: readonly TextureBinding[];
  readonly variants: readonly MaterialVariant[];
  readonly features: readonly MaterialFeature[];
}

export interface MaterialInstance {
  readonly id: MaterialInstanceId;
  readonly definition: MaterialDefinitionId;
  readonly definition_revision: number;
  readonly revision: number;
  readonly variant?: MaterialVariantId;
  readonly overrides: MaterialParameterOverrides;
}

export interface CanonicalMaterialRecord {
  readonly definition: MaterialDefinitionId;
  readonly definition_revision: number;
  readonly instance?: MaterialInstanceId;
  readonly instance_revision?: number;
  readonly variant?: MaterialVariantId;
  readonly parameters: PbrParameters;
  readonly dielectric_f0: LinearRgb;
  readonly specular_f0: LinearRgb;
  readonly diffuse_color: LinearRgb;
  readonly alpha: AlphaMode;
  readonly sidedness: Sidedness;
  readonly textures: readonly TextureBinding[];
  readonly stylized?: StylizedExtension;
  readonly feature_key: string;
}

export interface MaterialCapabilities {
  readonly supported_features: ReadonlySet<MaterialFeature>;
}

export interface MaterialVariantSelection {
  readonly id?: MaterialVariantId;
  readonly features: readonly MaterialFeature[];
  readonly degraded_from?: MaterialVariantId;
}

export const texture_features: Readonly<
  Partial<Record<TextureSemantic, MaterialFeature>>
> = Object.freeze({
  normal: "normal_map",
  occlusion: "occlusion",
  emissive: "emissive",
  clearcoat: "clearcoat",
  clearcoat_roughness: "clearcoat",
  transmission: "transmission",
  thickness: "volume",
});
