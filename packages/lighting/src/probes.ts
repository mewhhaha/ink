import { type Aabb, aabb_extents } from "@ink/geometry/shapes.ts";
import { linear_rgb } from "@ink/materials/color.ts";
import { type Vec3, vec3 } from "@ink/math/vector.ts";
import type { Observer } from "@ink/observability/observer.ts";
import { sample_prefiltered_environment } from "./environment.ts";
import type { EnvironmentId, ProbeId } from "./identity.ts";
import type {
  IrradianceProbe,
  LightMap,
  PrefilteredEnvironment,
  ReflectionProbe,
} from "./model.ts";

export interface ProbeWeight {
  readonly probe: ProbeId;
  readonly weight: number;
}

function immutable<Value>(value: Value): Value {
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

function validate_volume(id: ProbeId, volume: Aabb): void {
  const extents = aabb_extents(volume);
  if (extents.x <= 0 || extents.y <= 0 || extents.z <= 0) {
    throw new Error(
      `probe ${id} volume extents (${extents.x}, ${extents.y}, ${extents.z}) must be positive`,
    );
  }
}

function validate_probe_base(
  probe: IrradianceProbe | ReflectionProbe,
): void {
  if (!Number.isSafeInteger(probe.revision) || probe.revision < 0) {
    throw new Error(
      `probe ${probe.id} revision ${probe.revision} must be nonnegative`,
    );
  }
  if (!Number.isSafeInteger(probe.priority)) {
    throw new Error(
      `probe ${probe.id} priority ${probe.priority} must be a safe integer`,
    );
  }
  if (!Number.isFinite(probe.blend_distance) || probe.blend_distance < 0) {
    throw new Error(
      `probe ${probe.id} blend distance ${probe.blend_distance} must be finite and nonnegative`,
    );
  }
  validate_volume(probe.id, probe.volume);
}

export function create_irradiance_probe(
  input: IrradianceProbe,
): IrradianceProbe {
  validate_probe_base(input);
  if (input.spherical_harmonics.length !== 9) {
    throw new Error(
      `irradiance probe ${input.id} needs 9 coefficients, received ${input.spherical_harmonics.length}`,
    );
  }
  for (const [index, color] of input.spherical_harmonics.entries()) {
    for (const [channel, value] of Object.entries(color)) {
      if (!Number.isFinite(value)) {
        throw new Error(
          `irradiance probe ${input.id} coefficient ${index} ${channel} must be finite`,
        );
      }
    }
  }
  return immutable(input);
}

export function create_reflection_probe(
  input: ReflectionProbe,
): ReflectionProbe {
  validate_probe_base(input);
  return immutable(input);
}

function contains(bounds: Aabb, point: Vec3): boolean {
  return point.x >= bounds.minimum.x && point.x <= bounds.maximum.x &&
    point.y >= bounds.minimum.y && point.y <= bounds.maximum.y &&
    point.z >= bounds.minimum.z && point.z <= bounds.maximum.z;
}

function edge_weight(
  bounds: Aabb,
  point: Vec3,
  blend_distance: number,
): number {
  if (!contains(bounds, point)) return 0;
  if (blend_distance === 0) return 1;
  const edge = Math.min(
    point.x - bounds.minimum.x,
    bounds.maximum.x - point.x,
    point.y - bounds.minimum.y,
    bounds.maximum.y - point.y,
    point.z - bounds.minimum.z,
    bounds.maximum.z - point.z,
  );
  return Math.min(1, edge / blend_distance);
}

export function blend_probe_weights(
  probes: readonly (IrradianceProbe | ReflectionProbe)[],
  point: Vec3,
  maximum_probes: number,
  observer?: Observer,
): readonly ProbeWeight[] {
  if (!Number.isSafeInteger(maximum_probes) || maximum_probes <= 0) {
    throw new Error(
      `maximum probe count ${maximum_probes} must be a positive safe integer`,
    );
  }
  const candidates = probes.map((probe) => ({
    probe,
    weight: edge_weight(probe.volume, point, probe.blend_distance) *
      2 ** probe.priority,
  })).filter(({ weight }) => weight > 0).sort((left, right) =>
    right.probe.priority - left.probe.priority ||
    left.probe.id.localeCompare(right.probe.id)
  );
  const selected = candidates.slice(0, maximum_probes);
  const total = selected.reduce((sum, { weight }) => sum + weight, 0);
  const weights = selected.map(({ probe, weight }) =>
    Object.freeze({ probe: probe.id, weight: weight / total })
  );
  observer?.event("lighting.probes.blended", {
    candidate_count: candidates.length,
    selected_count: weights.length,
    overflow: Math.max(0, candidates.length - weights.length),
  });
  return Object.freeze(weights);
}

export function blend_irradiance(
  probes: readonly IrradianceProbe[],
  weights: readonly ProbeWeight[],
): readonly Vec3[] {
  const by_id = new Map(probes.map((probe) => [probe.id, probe]));
  return Object.freeze(Array.from({ length: 9 }, (_, coefficient) => {
    let r = 0;
    let g = 0;
    let b = 0;
    for (const weighted of weights) {
      const probe = by_id.get(weighted.probe);
      if (probe === undefined) {
        throw new Error(
          `probe blend references unavailable irradiance probe ${weighted.probe}`,
        );
      }
      r += probe.spherical_harmonics[coefficient].x * weighted.weight;
      g += probe.spherical_harmonics[coefficient].y * weighted.weight;
      b += probe.spherical_harmonics[coefficient].z * weighted.weight;
    }
    return vec3(r, g, b);
  }));
}

export function blend_reflections(
  probes: readonly ReflectionProbe[],
  weights: readonly ProbeWeight[],
  environments: ReadonlyMap<EnvironmentId, PrefilteredEnvironment>,
  direction: Vec3,
  roughness: number,
): ReturnType<typeof sample_prefiltered_environment> {
  const by_id = new Map(probes.map((probe) => [probe.id, probe]));
  let r = 0;
  let g = 0;
  let b = 0;
  for (const weighted of weights) {
    const probe = by_id.get(weighted.probe);
    if (probe === undefined) {
      throw new Error(
        `probe blend references unavailable reflection probe ${weighted.probe}`,
      );
    }
    const environment = environments.get(probe.environment);
    if (environment === undefined) {
      throw new Error(
        `reflection probe ${probe.id} references unavailable environment ${probe.environment}`,
      );
    }
    const sample = sample_prefiltered_environment(
      environment,
      direction,
      roughness,
    );
    r += sample.r * weighted.weight;
    g += sample.g * weighted.weight;
    b += sample.b * weighted.weight;
  }
  return linear_rgb(r, g, b);
}

export function create_light_map(input: LightMap): LightMap {
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
    throw new Error(`light map revision ${input.revision} must be nonnegative`);
  }
  if (
    !Number.isSafeInteger(input.uv_set) || input.uv_set < 0 || input.uv_set > 3
  ) {
    throw new Error(`light map UV set ${input.uv_set} must be within [0, 3]`);
  }
  if (!Number.isFinite(input.intensity) || input.intensity < 0) {
    throw new Error(
      `light map intensity ${input.intensity} must be finite and nonnegative`,
    );
  }
  return immutable(input);
}

export interface ProbeInvalidation {
  readonly probe: ProbeId;
  readonly reason: "new" | "revision" | "environment";
}

export function probe_invalidations(
  probes: readonly ReflectionProbe[],
  previous: ReadonlyMap<ProbeId, ReflectionProbe>,
  changed_environments: ReadonlySet<EnvironmentId>,
  observer?: Observer,
): readonly ProbeInvalidation[] {
  const invalidated: ProbeInvalidation[] = [];
  for (const probe of probes) {
    const prior = previous.get(probe.id);
    if (prior === undefined) {
      invalidated.push({ probe: probe.id, reason: "new" });
      continue;
    }
    if (prior.revision !== probe.revision) {
      invalidated.push({ probe: probe.id, reason: "revision" });
      continue;
    }
    if (changed_environments.has(probe.environment)) {
      invalidated.push({ probe: probe.id, reason: "environment" });
    }
  }
  invalidated.sort((left, right) => left.probe.localeCompare(right.probe));
  observer?.event("lighting.probes.invalidated", { count: invalidated.length });
  return Object.freeze(invalidated.map((entry) => Object.freeze(entry)));
}
