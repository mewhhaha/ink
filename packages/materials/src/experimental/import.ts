import type { AssetId } from "@ink/assets/identity.ts";
import type { Observer } from "@ink/observability/observer.ts";
import {
  linear_rgb,
  srgb_to_linear,
  type SrgbRgb,
  type SrgbRgba,
} from "../color.ts";
import {
  create_material_definition,
  default_pbr_parameters,
} from "../canonical.ts";
import type { MaterialDefinitionId } from "../identity.ts";
import type {
  AlphaMode,
  MaterialDefinition,
  MaterialVariant,
  Sidedness,
  StylizedExtension,
} from "../model.ts";
import type { TextureBinding } from "../texture.ts";

interface ImportedMaterialBase {
  readonly id: MaterialDefinitionId;
  readonly revision: number;
  readonly source?: AssetId<"gltf.material">;
  readonly alpha?: AlphaMode;
  readonly sidedness?: Sidedness;
  readonly textures?: readonly TextureBinding[];
  readonly stylized?: StylizedExtension;
  readonly variants?: readonly MaterialVariant[];
}

export interface MetallicRoughnessWorkflow extends ImportedMaterialBase {
  readonly base_color: SrgbRgba;
  readonly metallic: number;
  readonly perceptual_roughness: number;
  readonly index_of_refraction?: number;
  readonly specular_factor?: number;
  readonly specular_tint?: SrgbRgb;
}

export interface SpecularGlossinessWorkflow extends ImportedMaterialBase {
  readonly diffuse: SrgbRgba;
  readonly specular: SrgbRgb;
  readonly glossiness: number;
}

export interface MaterialImportOptions {
  readonly observer?: Observer;
}

export interface MaterialImportResult {
  readonly definition: MaterialDefinition;
  readonly warnings: readonly string[];
}

function common(input: ImportedMaterialBase) {
  return {
    id: input.id,
    revision: input.revision,
    alpha: input.alpha ?? { type: "opaque" as const },
    sidedness: input.sidedness ?? "front" as const,
    textures: input.textures ?? [],
    ...(input.stylized === undefined ? {} : { stylized: input.stylized }),
    variants: input.variants ?? [],
  };
}

function imported(
  definition: MaterialDefinition,
  workflow: string,
  source: AssetId<"gltf.material"> | undefined,
  warnings: readonly string[],
  observer: Observer | undefined,
): MaterialImportResult {
  observer?.event("material.import.converted", {
    material_id: definition.id,
    workflow,
    source: source ?? "direct",
    warning_count: warnings.length,
  });
  for (const warning of warnings) {
    observer?.event("material.import.warning", {
      material_id: definition.id,
      workflow,
      warning,
    });
  }
  return Object.freeze({ definition, warnings: Object.freeze([...warnings]) });
}

export function import_metallic_roughness(
  input: MetallicRoughnessWorkflow,
  options: MaterialImportOptions = {},
): MaterialImportResult {
  const defaults = default_pbr_parameters();
  const base_color = srgb_to_linear(input.base_color);
  const specular_tint = input.specular_tint === undefined
    ? defaults.specular_tint
    : srgb_to_linear(input.specular_tint);
  const specular_factor = input.specular_factor ?? 1;
  if (
    !Number.isFinite(specular_factor) || specular_factor < 0 ||
    specular_factor > 1
  ) {
    throw new Error(
      `material ${input.id} specular factor ${
        String(specular_factor)
      } must be within [0, 1]`,
    );
  }
  const definition = create_material_definition({
    ...common(input),
    parameters: {
      ...defaults,
      base_color,
      metallic: input.metallic,
      perceptual_roughness: input.perceptual_roughness,
      index_of_refraction: input.index_of_refraction ??
        defaults.index_of_refraction,
      specular_level: 0.04 * specular_factor,
      specular_tint,
    },
  });
  return imported(
    definition,
    "metallic_roughness",
    input.source,
    [],
    options.observer,
  );
}

export function import_specular_glossiness(
  input: SpecularGlossinessWorkflow,
  options: MaterialImportOptions = {},
): MaterialImportResult {
  if (
    !Number.isFinite(input.glossiness) || input.glossiness < 0 ||
    input.glossiness > 1
  ) {
    throw new Error(
      `material ${input.id} glossiness ${
        String(input.glossiness)
      } must be within [0, 1]`,
    );
  }
  const defaults = default_pbr_parameters();
  const diffuse = srgb_to_linear(input.diffuse);
  const specular = srgb_to_linear(input.specular);
  const specular_level = Math.max(specular.r, specular.g, specular.b);
  const specular_tint = specular_level === 0 ? linear_rgb(1, 1, 1) : linear_rgb(
    specular.r / specular_level,
    specular.g / specular_level,
    specular.b / specular_level,
  );
  const warnings = [
    "specular-glossiness has no metalness term; imported as an explicit dielectric F0 surface",
  ];
  const definition = create_material_definition({
    ...common(input),
    parameters: {
      ...defaults,
      base_color: diffuse,
      metallic: 0,
      perceptual_roughness: 1 - input.glossiness,
      specular_level,
      specular_tint,
    },
  });
  return imported(
    definition,
    "specular_glossiness",
    input.source,
    warnings,
    options.observer,
  );
}
