import type { CameraView } from "@ink/camera/view.ts";
import type { Observer } from "@ink/observability/observer.ts";
import type { VisibleSet } from "@ink/visibility/model.ts";
import {
  build_clustered_light_plan,
  type ClusteredLightPlan,
} from "./clusters.ts";
import {
  resolve_exposure,
  type ResolvedExposure,
  validate_atmosphere,
} from "./environment.ts";
import type { EnvironmentId, LightId, ProbeId } from "./identity.ts";
import { create_light } from "./light.ts";
import type {
  AtmosphereInput,
  ExposureInput,
  IrradianceProbe,
  LightDefinition,
  LightingQuality,
  LightMap,
  PrefilteredEnvironment,
  QualityReduction,
  ReflectionProbe,
} from "./model.ts";
import {
  create_irradiance_probe,
  create_light_map,
  create_reflection_probe,
} from "./probes.ts";
import { reduce_lighting_quality } from "./quality.ts";
import {
  build_shadow_plan,
  type ShadowCacheEntry,
  type ShadowPlan,
} from "./shadows.ts";

export type LightingRenderPath =
  | "compatibility"
  | "clustered_forward"
  | "deferred";

export interface LightingPlan {
  readonly revision: number;
  readonly camera: CameraView["camera"];
  readonly lights: readonly LightDefinition[];
  readonly environments: readonly EnvironmentId[];
  readonly irradiance_probes: readonly ProbeId[];
  readonly reflection_probes: readonly ProbeId[];
  readonly light_maps: readonly LightMap[];
  readonly clusters: ClusteredLightPlan;
  readonly shadows: ShadowPlan;
  readonly exposure: ResolvedExposure;
  readonly atmosphere?: AtmosphereInput;
  readonly quality: LightingQuality;
  readonly quality_reductions: readonly QualityReduction[];
  readonly visibility_revision?: VisibleSet["input_revision"];
}

export interface LightingPlanInput {
  readonly revision: number;
  readonly view: CameraView;
  readonly camera_revision: number;
  readonly caster_revision: number;
  readonly frame_index: number;
  readonly lights: readonly LightDefinition[];
  readonly environments: ReadonlyMap<EnvironmentId, PrefilteredEnvironment>;
  readonly irradiance_probes?: readonly IrradianceProbe[];
  readonly reflection_probes?: readonly ReflectionProbe[];
  readonly light_maps?: readonly LightMap[];
  readonly exposure: ExposureInput;
  readonly metered_ev100: number;
  readonly previous_ev100: number;
  readonly delta_seconds: number;
  readonly atmosphere?: AtmosphereInput;
  readonly quality: LightingQuality;
  readonly quality_pressure: number;
  readonly visibility_revision?: VisibleSet["input_revision"];
  readonly previous_shadow_cache?: ReadonlyMap<LightId, ShadowCacheEntry>;
  readonly observer?: Observer;
}

export function build_lighting_plan(input: LightingPlanInput): LightingPlan {
  const span = input.observer?.start_span("lighting.plan.build", {
    revision: input.revision,
    input_light_count: input.lights.length,
  });
  try {
    if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
      throw new Error(
        `lighting plan revision ${input.revision} must be a nonnegative safe integer`,
      );
    }
    const lights = input.lights.map(create_light);
    const identities = new Set<LightId>();
    for (const light of lights) {
      if (identities.has(light.id)) {
        throw new Error(
          `lighting plan revision ${input.revision} repeats light ${light.id}`,
        );
      }
      identities.add(light.id);
      if (
        light.type === "environment" &&
        !input.environments.has(light.environment)
      ) {
        throw new Error(
          `environment light ${light.id} references unavailable environment ${light.environment}`,
        );
      }
    }
    const reduced = reduce_lighting_quality(
      input.quality,
      input.quality_pressure,
    );
    const ordered = lights.sort((left, right) =>
      right.importance - left.importance || left.id.localeCompare(right.id)
    );
    const selected = ordered.slice(0, reduced.quality.maximum_lights);
    const global_rejected = ordered.length - selected.length;
    const irradiance = (input.irradiance_probes ?? []).map(
      create_irradiance_probe,
    )
      .sort((left, right) =>
        right.priority - left.priority || left.id.localeCompare(right.id)
      ).slice(0, reduced.quality.maximum_probes);
    const reflections = (input.reflection_probes ?? []).map(
      create_reflection_probe,
    )
      .sort((left, right) =>
        right.priority - left.priority || left.id.localeCompare(right.id)
      ).slice(0, reduced.quality.maximum_probes);
    for (const probe of reflections) {
      if (!input.environments.has(probe.environment)) {
        throw new Error(
          `reflection probe ${probe.id} references unavailable environment ${probe.environment}`,
        );
      }
    }
    const atmosphere = input.atmosphere === undefined
      ? undefined
      : validate_atmosphere(input.atmosphere);
    if (
      atmosphere !== undefined &&
      !selected.some((light) =>
        light.id === atmosphere.sun && light.type === "directional"
      )
    ) {
      throw new Error(
        `atmosphere sun ${atmosphere.sun} must reference a selected directional light`,
      );
    }
    const clusters = build_clustered_light_plan({
      view: input.view,
      lights: selected,
      grid: reduced.quality.clusters,
      maximum_lights: reduced.quality.maximum_lights,
      ...(input.visibility_revision === undefined
        ? {}
        : { visibility_revision: input.visibility_revision }),
      observer: input.observer,
    });
    const shadows = build_shadow_plan({
      view: input.view,
      camera_revision: input.camera_revision,
      caster_revision: input.caster_revision,
      frame_index: input.frame_index,
      lights: selected,
      quality: reduced.quality.shadows,
      previous_cache: input.previous_shadow_cache,
      observer: input.observer,
    });
    const exposure = resolve_exposure(
      input.exposure,
      input.metered_ev100,
      input.previous_ev100,
      input.delta_seconds,
    );
    const environment_ids = selected.filter((light) =>
      light.type === "environment"
    ).sort((left, right) => {
      if (left.type !== "environment" || right.type !== "environment") return 0;
      return right.priority - left.priority || left.id.localeCompare(right.id);
    }).flatMap((light) =>
      light.type === "environment" ? [light.environment] : []
    );
    const light_maps = (input.light_maps ?? []).map(create_light_map);
    for (const reduction of reduced.reductions) {
      input.observer?.event("lighting.quality.reduced", {
        field: reduction.field,
        from: reduction.from,
        to: reduction.to,
      });
    }
    const plan: LightingPlan = Object.freeze({
      revision: input.revision,
      camera: input.view.camera,
      lights: Object.freeze(selected),
      environments: Object.freeze(environment_ids),
      irradiance_probes: Object.freeze(irradiance.map(({ id }) => id)),
      reflection_probes: Object.freeze(reflections.map(({ id }) => id)),
      light_maps: Object.freeze(light_maps),
      clusters,
      shadows,
      exposure,
      ...(atmosphere === undefined ? {} : { atmosphere }),
      quality: reduced.quality,
      quality_reductions: reduced.reductions,
      ...(input.visibility_revision === undefined
        ? {}
        : { visibility_revision: input.visibility_revision }),
    });
    span?.end({
      light_count: selected.length,
      rejected_lights: global_rejected,
      cluster_overflow: clusters.cluster_overflow_count,
      shadow_views: shadows.views.length,
      probe_count: irradiance.length + reflections.length,
    });
    return plan;
  } catch (error) {
    span?.end({ failed: true });
    throw error;
  }
}

export function lighting_plan_for_path(
  plan: LightingPlan,
  path: LightingRenderPath,
): LightingPlan {
  if (!["compatibility", "clustered_forward", "deferred"].includes(path)) {
    throw new Error(
      `lighting render path ${JSON.stringify(path)} is unsupported`,
    );
  }
  return plan;
}
