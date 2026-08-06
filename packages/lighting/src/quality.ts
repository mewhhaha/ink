import type { LightingQuality, QualityReduction } from "./model.ts";

export interface ReducedLightingQuality {
  readonly quality: LightingQuality;
  readonly reductions: readonly QualityReduction[];
}

function immutable_quality(quality: LightingQuality): LightingQuality {
  return Object.freeze({
    ...quality,
    clusters: Object.freeze({ ...quality.clusters }),
    shadows: Object.freeze({ ...quality.shadows }),
  });
}

export function validate_lighting_quality(
  quality: LightingQuality,
): LightingQuality {
  for (const [field, value] of Object.entries(quality.clusters)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(
        `lighting cluster ${field} ${value} must be a positive safe integer`,
      );
    }
  }
  if (![1024, 2048, 4096, 8192].includes(quality.shadows.atlas_size)) {
    throw new Error(
      `lighting shadow atlas size ${quality.shadows.atlas_size} is unsupported`,
    );
  }
  if (![1, 2, 3, 4].includes(quality.shadows.cascade_count)) {
    throw new Error(
      `lighting cascade count ${quality.shadows.cascade_count} must be within [1, 4]`,
    );
  }
  if (
    !Number.isFinite(quality.shadows.cascade_lambda) ||
    quality.shadows.cascade_lambda < 0 || quality.shadows.cascade_lambda > 1
  ) {
    throw new Error(
      `lighting cascade lambda ${quality.shadows.cascade_lambda} must be within [0, 1]`,
    );
  }
  if (![1, 0.5, 0.25].includes(quality.shadows.resolution_scale)) {
    throw new Error(
      `lighting shadow resolution scale ${quality.shadows.resolution_scale} must be 1, 0.5, or 0.25`,
    );
  }
  if (
    !Number.isSafeInteger(quality.shadows.cached_update_interval_multiplier) ||
    quality.shadows.cached_update_interval_multiplier <= 0
  ) {
    throw new Error(
      `lighting cached shadow update multiplier ${quality.shadows.cached_update_interval_multiplier} must be a positive safe integer`,
    );
  }
  for (
    const [field, value] of [
      ["maximum shadowed lights", quality.shadows.maximum_shadowed_lights],
      ["maximum lights", quality.maximum_lights],
      ["maximum probes", quality.maximum_probes],
      ["environment roughness levels", quality.environment_roughness_levels],
    ] as const
  ) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(
        `lighting ${field} ${value} must be a positive safe integer`,
      );
    }
  }
  return immutable_quality(quality);
}

export function reduce_lighting_quality(
  input: LightingQuality,
  pressure: number,
): ReducedLightingQuality {
  const quality = validate_lighting_quality(input);
  if (!Number.isFinite(pressure) || pressure < 0 || pressure > 1) {
    throw new Error(
      `lighting quality pressure ${pressure} must be within [0, 1]`,
    );
  }
  const reductions: QualityReduction[] = [];
  const apply = (field: string, from: number, to: number) => {
    if (from !== to) reductions.push(Object.freeze({ field, from, to }));
  };
  const maximum_lights = Math.min(
    quality.maximum_lights,
    Math.max(1, Math.floor(quality.maximum_lights * (1 - pressure * 0.75))),
  );
  apply("maximum_lights", quality.maximum_lights, maximum_lights);
  const maximum_lights_per_cluster = Math.min(
    quality.clusters.maximum_lights_per_cluster,
    Math.max(
      1,
      Math.floor(
        quality.clusters.maximum_lights_per_cluster * (1 - pressure * 0.75),
      ),
    ),
  );
  apply(
    "maximum_lights_per_cluster",
    quality.clusters.maximum_lights_per_cluster,
    maximum_lights_per_cluster,
  );
  const maximum_shadowed_lights = Math.max(
    1,
    Math.floor(quality.shadows.maximum_shadowed_lights * (1 - pressure * 0.75)),
  );
  apply(
    "maximum_shadowed_lights",
    quality.shadows.maximum_shadowed_lights,
    maximum_shadowed_lights,
  );
  const pressure_resolution_scale = pressure >= 2 / 3
    ? 0.25
    : pressure >= 1 / 3
    ? 0.5
    : 1;
  const resolution_scale = Math.min(
    quality.shadows.resolution_scale,
    pressure_resolution_scale,
  ) as 1 | 0.5 | 0.25;
  apply(
    "shadow_resolution_scale",
    quality.shadows.resolution_scale,
    resolution_scale,
  );
  const cached_update_interval_multiplier = Math.max(
    quality.shadows.cached_update_interval_multiplier,
    1 + Math.floor(pressure * 3),
  );
  apply(
    "cached_shadow_update_interval_multiplier",
    quality.shadows.cached_update_interval_multiplier,
    cached_update_interval_multiplier,
  );
  const maximum_probes = Math.max(
    1,
    Math.floor(quality.maximum_probes * (1 - pressure * 0.75)),
  );
  apply("maximum_probes", quality.maximum_probes, maximum_probes);
  const environment_roughness_levels = Math.max(
    2,
    Math.floor(quality.environment_roughness_levels * (1 - pressure * 0.5)),
  );
  apply(
    "environment_roughness_levels",
    quality.environment_roughness_levels,
    environment_roughness_levels,
  );
  const reduced: LightingQuality = {
    ...quality,
    maximum_lights,
    maximum_probes,
    environment_roughness_levels,
    clusters: { ...quality.clusters, maximum_lights_per_cluster },
    shadows: {
      ...quality.shadows,
      maximum_shadowed_lights,
      resolution_scale,
      cached_update_interval_multiplier,
    },
  };
  return Object.freeze({
    quality: immutable_quality(reduced),
    reductions: Object.freeze(reductions),
  });
}
