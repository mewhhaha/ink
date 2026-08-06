import { linear_rgb, linear_rgba, type LinearRgb } from "./color.ts";
import {
  material_definition_id,
  material_variant_id,
  type MaterialVariantId,
} from "./identity.ts";
import {
  type CanonicalMaterialRecord,
  type MaterialCapabilities,
  type MaterialDefinition,
  type MaterialDefinitionInput,
  type MaterialFeature,
  type MaterialInstance,
  type MaterialParameterOverrides,
  type MaterialVariant,
  type MaterialVariantSelection,
  type PbrParameters,
  texture_features,
} from "./model.ts";
import { texture_binding } from "./texture.ts";

export function default_pbr_parameters(): PbrParameters {
  return Object.freeze({
    base_color: linear_rgba(1, 1, 1, 1),
    metallic: 0,
    perceptual_roughness: 1,
    specular_level: 0.04,
    specular_tint: linear_rgb(1, 1, 1),
    normal_scale: 1,
    occlusion_strength: 1,
    emissive: linear_rgb(0, 0, 0),
    emissive_strength: 1,
    clearcoat: 0,
    clearcoat_roughness: 0,
    transmission: 0,
    thickness: 0,
    index_of_refraction: 1.5,
  });
}

function bounded(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(
      `${label} ${String(value)} must be within [${minimum}, ${maximum}]`,
    );
  }
}

function validate_parameters(
  parameters: PbrParameters,
  definition: string,
): void {
  for (const [channel, value] of Object.entries(parameters.base_color)) {
    bounded(value, 0, 1, `material ${definition} base color ${channel}`);
  }
  bounded(parameters.metallic, 0, 1, `material ${definition} metallic`);
  bounded(
    parameters.perceptual_roughness,
    0,
    1,
    `material ${definition} perceptual roughness`,
  );
  bounded(
    parameters.specular_level,
    0,
    1,
    `material ${definition} specular level`,
  );
  for (const [channel, value] of Object.entries(parameters.specular_tint)) {
    bounded(value, 0, 1, `material ${definition} specular tint ${channel}`);
  }
  bounded(parameters.normal_scale, 0, 2, `material ${definition} normal scale`);
  bounded(
    parameters.occlusion_strength,
    0,
    1,
    `material ${definition} occlusion strength`,
  );
  for (const [channel, value] of Object.entries(parameters.emissive)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(
        `material ${definition} emissive ${channel} ${
          String(value)
        } must be finite and nonnegative`,
      );
    }
  }
  bounded(
    parameters.emissive_strength,
    0,
    100,
    `material ${definition} emissive strength`,
  );
  bounded(parameters.clearcoat, 0, 1, `material ${definition} clearcoat`);
  bounded(
    parameters.clearcoat_roughness,
    0,
    1,
    `material ${definition} clearcoat roughness`,
  );
  bounded(parameters.transmission, 0, 1, `material ${definition} transmission`);
  bounded(parameters.thickness, 0, 1_000, `material ${definition} thickness`);
  bounded(
    parameters.index_of_refraction,
    1,
    2.5,
    `material ${definition} index of refraction`,
  );
  if (parameters.thickness > 0 && parameters.transmission === 0) {
    throw new Error(
      `material ${definition} thickness requires nonzero transmission`,
    );
  }
}

function features_for(
  input: MaterialDefinitionInput,
): readonly MaterialFeature[] {
  const features = new Set<MaterialFeature>();
  if (input.alpha.type === "mask") features.add("alpha_mask");
  if (input.alpha.type === "blend") features.add("alpha_blend");
  if (input.sidedness === "double") features.add("double_sided");
  if (input.parameters.clearcoat > 0) features.add("clearcoat");
  if (input.parameters.transmission > 0) features.add("transmission");
  if (input.parameters.thickness > 0) features.add("volume");
  if (
    input.parameters.emissive_strength > 0 &&
    (input.parameters.emissive.r > 0 || input.parameters.emissive.g > 0 ||
      input.parameters.emissive.b > 0)
  ) features.add("emissive");
  for (const texture of input.textures ?? []) {
    const feature = texture_features[texture.semantic];
    if (feature !== undefined) features.add(feature);
  }
  if (input.stylized !== undefined) features.add(input.stylized.type);
  return Object.freeze([...features].sort());
}

function validate_variants(
  definition: string,
  variants: readonly MaterialVariant[],
  features: readonly MaterialFeature[],
): void {
  const by_id = new Map<MaterialVariantId, MaterialVariant>();
  for (const variant of variants) {
    if (material_variant_id(variant.id) !== variant.id) {
      throw new Error(
        `material ${definition} variant ${variant.id} is not canonical`,
      );
    }
    if (by_id.has(variant.id)) {
      throw new Error(`material ${definition} repeats variant ${variant.id}`);
    }
    const requirements = new Set(variant.required_features);
    if (requirements.size !== variant.required_features.length) {
      throw new Error(
        `material ${definition} variant ${variant.id} repeats a feature`,
      );
    }
    for (const feature of requirements) {
      if (!features.includes(feature)) {
        throw new Error(
          `material ${definition} variant ${variant.id} requires absent feature ${feature}`,
        );
      }
    }
    by_id.set(variant.id, variant);
  }
  for (const variant of variants) {
    const seen = new Set<MaterialVariantId>([variant.id]);
    let current = variant;
    while (current.fallback !== undefined) {
      const fallback = by_id.get(current.fallback);
      if (fallback === undefined) {
        throw new Error(
          `material ${definition} variant ${current.id} fallback ${current.fallback} does not exist`,
        );
      }
      if (seen.has(fallback.id)) {
        throw new Error(
          `material ${definition} variant fallback cycle reaches ${fallback.id}`,
        );
      }
      const current_features = new Set(current.required_features);
      if (
        fallback.required_features.some((feature) =>
          !current_features.has(feature)
        )
      ) {
        throw new Error(
          `material ${definition} fallback ${fallback.id} adds a feature not required by ${current.id}`,
        );
      }
      seen.add(fallback.id);
      current = fallback;
    }
  }
}

function validate_stylized(input: MaterialDefinitionInput): void {
  if (input.stylized?.type === "toon") {
    if (
      !Number.isSafeInteger(input.stylized.bands) || input.stylized.bands < 2 ||
      input.stylized.bands > 16
    ) {
      throw new Error(
        `material ${input.id} toon bands ${input.stylized.bands} must be an integer within [2, 16]`,
      );
    }
    bounded(
      input.stylized.edge_softness,
      0,
      0.5,
      `material ${input.id} toon edge softness`,
    );
    bounded(
      input.stylized.rim_strength,
      0,
      1,
      `material ${input.id} toon rim strength`,
    );
    if (input.parameters.transmission > 0) {
      throw new Error(
        `material ${input.id} cannot combine toon shading and transmission`,
      );
    }
  }
  if (input.stylized?.type === "unlit") {
    if (input.parameters.clearcoat > 0 || input.parameters.transmission > 0) {
      throw new Error(
        `material ${input.id} unlit extension conflicts with clearcoat or transmission`,
      );
    }
    for (const [channel, value] of Object.entries(input.stylized.tint)) {
      bounded(value, 0, 1, `material ${input.id} unlit tint ${channel}`);
    }
  }
}

function immutable<T>(value: T): T {
  const clone = structuredClone(value);
  const freeze = (current: unknown): void => {
    if (
      current === null || typeof current !== "object" ||
      Object.isFrozen(current)
    ) return;
    for (const property of Object.values(current)) freeze(property);
    Object.freeze(current);
  };
  freeze(clone);
  return clone;
}

export function create_material_definition(
  input: MaterialDefinitionInput,
): MaterialDefinition {
  if (material_definition_id(input.id) !== input.id) {
    throw new Error(
      `material definition identity ${input.id} is not canonical`,
    );
  }
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
    throw new Error(
      `material ${input.id} revision ${input.revision} must be a nonnegative safe integer`,
    );
  }
  validate_parameters(input.parameters, input.id);
  if (!["opaque", "mask", "blend"].includes(input.alpha.type)) {
    throw new Error(
      `material ${input.id} alpha mode ${
        JSON.stringify(input.alpha.type)
      } is unsupported`,
    );
  }
  if (!["front", "double"].includes(input.sidedness)) {
    throw new Error(
      `material ${input.id} sidedness ${
        JSON.stringify(input.sidedness)
      } is unsupported`,
    );
  }
  if (
    input.stylized !== undefined &&
    !["toon", "unlit"].includes(input.stylized.type)
  ) {
    throw new Error(
      `material ${input.id} stylized extension ${
        JSON.stringify(input.stylized.type)
      } is unsupported`,
    );
  }
  if (input.alpha.type === "mask") {
    bounded(input.alpha.cutoff, 0, 1, `material ${input.id} alpha cutoff`);
  }
  if (input.alpha.type === "blend" && input.parameters.transmission > 0) {
    throw new Error(
      `material ${input.id} cannot combine alpha blend and transmission`,
    );
  }
  validate_stylized(input);
  const textures = (input.textures ?? []).map(texture_binding);
  const semantics = new Set<string>();
  for (const texture of textures) {
    if (semantics.has(texture.semantic)) {
      throw new Error(
        `material ${input.id} repeats ${texture.semantic} texture`,
      );
    }
    semantics.add(texture.semantic);
  }
  const definition_source = { ...input, textures };
  const features = features_for(definition_source);
  if (features.includes("volume") && !features.includes("transmission")) {
    throw new Error(
      `material ${input.id} thickness requires a transmission factor or texture`,
    );
  }
  if (
    input.stylized?.type === "toon" &&
    (features.includes("transmission") || features.includes("volume"))
  ) {
    throw new Error(
      `material ${input.id} cannot combine toon shading and transmission features`,
    );
  }
  if (
    input.stylized?.type === "unlit" &&
    features.some((feature) =>
      ["normal_map", "occlusion", "clearcoat", "transmission", "volume"]
        .includes(feature)
    )
  ) {
    throw new Error(
      `material ${input.id} unlit extension conflicts with physical surface features`,
    );
  }
  const variants = input.variants ?? [];
  validate_variants(input.id, variants, features);
  return immutable({ ...definition_source, variants, features });
}

export function apply_material_overrides(
  definition: MaterialDefinition,
  overrides: MaterialParameterOverrides,
): PbrParameters {
  const parameters = { ...definition.parameters, ...overrides };
  validate_parameters(parameters, definition.id);
  const enabled_by_override: readonly [MaterialFeature, boolean][] = [
    ["clearcoat", parameters.clearcoat > 0],
    ["transmission", parameters.transmission > 0],
    ["volume", parameters.thickness > 0],
    [
      "emissive",
      parameters.emissive_strength > 0 &&
      (parameters.emissive.r > 0 || parameters.emissive.g > 0 ||
        parameters.emissive.b > 0),
    ],
  ];
  for (const [feature, enabled] of enabled_by_override) {
    if (enabled && !definition.features.includes(feature)) {
      throw new Error(
        `material ${definition.id} instance override cannot enable undeclared feature ${feature}`,
      );
    }
  }
  if (definition.alpha.type === "blend" && parameters.transmission > 0) {
    throw new Error(
      `material ${definition.id} instance cannot combine alpha blend and transmission`,
    );
  }
  if (definition.stylized?.type === "toon" && parameters.transmission > 0) {
    throw new Error(
      `material ${definition.id} instance cannot combine toon shading and transmission`,
    );
  }
  if (
    definition.stylized?.type === "unlit" &&
    (parameters.clearcoat > 0 || parameters.transmission > 0)
  ) {
    throw new Error(
      `material ${definition.id} unlit instance conflicts with clearcoat or transmission`,
    );
  }
  return immutable(parameters);
}

export function material_feature_key(
  features: readonly MaterialFeature[],
): string {
  return [...new Set(features)].sort().join("+") || "base";
}

export function select_material_variant(
  definition: MaterialDefinition,
  requested: MaterialVariantId | undefined,
  capabilities: MaterialCapabilities,
): MaterialVariantSelection {
  if (requested === undefined) {
    const unsupported = definition.features.filter((feature) =>
      !capabilities.supported_features.has(feature)
    );
    if (unsupported.length > 0) {
      throw new Error(
        `material ${definition.id} base variant requires unsupported features ${
          unsupported.join(", ")
        }`,
      );
    }
    return Object.freeze({ features: definition.features });
  }
  const variants = new Map(
    definition.variants.map((variant) => [variant.id, variant]),
  );
  let variant = variants.get(requested);
  if (variant === undefined) {
    throw new Error(
      `material ${definition.id} variant ${requested} does not exist`,
    );
  }
  while (true) {
    if (
      variant.required_features.every((feature) =>
        capabilities.supported_features.has(feature)
      )
    ) {
      return Object.freeze({
        id: variant.id,
        features: variant.required_features,
        ...(variant.id === requested ? {} : { degraded_from: requested }),
      });
    }
    if (variant.fallback === undefined) {
      const unsupported = variant.required_features.filter((feature) =>
        !capabilities.supported_features.has(feature)
      );
      throw new Error(
        `material ${definition.id} variant ${requested} requires unsupported features ${
          unsupported.join(", ")
        } and has no usable fallback`,
      );
    }
    variant = variants.get(variant.fallback)!;
  }
}

function dielectric_f0(parameters: PbrParameters): LinearRgb {
  const natural = ((parameters.index_of_refraction - 1) /
    (parameters.index_of_refraction + 1)) ** 2;
  const level = Math.min(1, parameters.specular_level * natural / 0.04);
  return linear_rgb(
    Math.min(1, parameters.specular_tint.r * level),
    Math.min(1, parameters.specular_tint.g * level),
    Math.min(1, parameters.specular_tint.b * level),
  );
}

export function canonical_material_record(
  definition: MaterialDefinition,
  instance?: MaterialInstance,
  capabilities?: MaterialCapabilities,
): CanonicalMaterialRecord {
  if (instance !== undefined && instance.definition !== definition.id) {
    throw new Error(
      `material instance ${instance.id} references ${instance.definition}, not definition ${definition.id}`,
    );
  }
  if (
    instance !== undefined &&
    instance.definition_revision !== definition.revision
  ) {
    throw new Error(
      `material instance ${instance.id} retains definition revision ${instance.definition_revision}, current is ${definition.revision}`,
    );
  }
  const parameters = instance === undefined
    ? definition.parameters
    : apply_material_overrides(definition, instance.overrides);
  const selection = capabilities === undefined
    ? { id: instance?.variant, features: definition.features }
    : select_material_variant(definition, instance?.variant, capabilities);
  const dielectric = dielectric_f0(parameters);
  const specular = linear_rgb(
    dielectric.r * (1 - parameters.metallic) +
      parameters.base_color.r * parameters.metallic,
    dielectric.g * (1 - parameters.metallic) +
      parameters.base_color.g * parameters.metallic,
    dielectric.b * (1 - parameters.metallic) +
      parameters.base_color.b * parameters.metallic,
  );
  const remaining_energy = 1 - Math.max(specular.r, specular.g, specular.b);
  const diffuse_scale = (1 - parameters.metallic) * remaining_energy;
  return immutable({
    definition: definition.id,
    definition_revision: definition.revision,
    ...(instance === undefined
      ? {}
      : { instance: instance.id, instance_revision: instance.revision }),
    ...(selection.id === undefined ? {} : { variant: selection.id }),
    parameters,
    dielectric_f0: dielectric,
    specular_f0: specular,
    diffuse_color: linear_rgb(
      parameters.base_color.r * diffuse_scale,
      parameters.base_color.g * diffuse_scale,
      parameters.base_color.b * diffuse_scale,
    ),
    alpha: definition.alpha,
    sidedness: definition.sidedness,
    textures: definition.textures,
    ...(definition.stylized === undefined
      ? {}
      : { stylized: definition.stylized }),
    feature_key: material_feature_key(selection.features),
  });
}

export function serialize_canonical_material(
  record: CanonicalMaterialRecord,
): string {
  return JSON.stringify(record);
}
