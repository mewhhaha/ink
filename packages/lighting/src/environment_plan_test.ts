import {
  assertAlmostEquals,
  assertEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { asset_id } from "@ink/assets/identity.ts";
import { aabb } from "@ink/geometry/shapes.ts";
import { linear_rgb } from "@ink/materials/color.ts";
import {
  canonical_material_record,
  create_material_definition,
  default_pbr_parameters,
} from "@ink/materials/canonical.ts";
import { material_definition_id } from "@ink/materials/identity.ts";
import { vec3 } from "@ink/math/vector.ts";
import {
  atmosphere_transmittance,
  evaluate_image_based_light,
  evaluate_irradiance_sh,
  import_environment_image,
  prefilter_environment,
  resolve_exposure,
  sample_prefiltered_environment,
} from "./experimental/environment.ts";
import { environment_id, probe_id } from "./identity.ts";
import {
  build_lighting_plan,
  lighting_plan_for_path,
} from "./experimental/plan.ts";
import {
  blend_probe_weights,
  create_irradiance_probe,
  create_reflection_probe,
  probe_invalidations,
} from "./experimental/probes.ts";
import { reduce_lighting_quality } from "./experimental/quality.ts";
import { camera_view, lighting_quality, point_light } from "./test_fixtures.ts";

Deno.test("constant environments prefilter and sample without directional color drift", () => {
  const color = linear_rgb(2, 1, 0.5);
  const environment = prefilter_environment({
    id: environment_id("studio"),
    revision: 1,
    width: 4,
    height: 2,
    pixels: Array.from({ length: 8 }, () => color),
  }, 4);
  const reflection = sample_prefiltered_environment(
    environment,
    vec3(1, 0, 0),
    0.6,
  );
  assertAlmostEquals(reflection.r, 2, 1e-12);
  assertAlmostEquals(reflection.g, 1, 1e-12);
  assertAlmostEquals(reflection.b, 0.5, 1e-12);
  const irradiance = evaluate_irradiance_sh(
    environment.irradiance_sh,
    vec3(0, 1, 0),
  );
  assertGreaterThanZero(irradiance.r);
  const material = canonical_material_record(create_material_definition({
    id: material_definition_id("ibl.fixture"),
    revision: 0,
    parameters: default_pbr_parameters(),
    alpha: { type: "opaque" },
    sidedness: "front",
  }));
  const ibl = evaluate_image_based_light(
    material,
    environment,
    vec3(0, 1, 0),
    vec3(0, 1, 0),
    1,
    0,
  );
  assertGreaterThanZero(ibl.diffuse.r);
  assertGreaterThanZero(ibl.specular.r);
});

function assertGreaterThanZero(value: number): void {
  if (!(value > 0)) {
    throw new Error(`expected ${value} to be greater than zero`);
  }
}

Deno.test("decoded sRGB environment images import through an explicit linear boundary", () => {
  const source = import_environment_image(
    environment_id("image"),
    0,
    asset_id<"environment">("sky.hdr"),
    {
      width: 1,
      height: 1,
      rgba8: new Uint8Array([128, 128, 128, 255]),
      color_space: "srgb",
      mip_level_count: 1,
    },
  );
  assertAlmostEquals(source.pixels[0].r, 0.21586050011389926, 1e-12);
});

Deno.test("probe blending is normalized and bounded by stable priority", () => {
  const coefficients = Array.from({ length: 9 }, () => vec3(1, 1, 1));
  const low = create_irradiance_probe({
    id: probe_id("low"),
    revision: 0,
    volume: aabb(vec3(-2, -2, -2), vec3(2, 2, 2)),
    priority: 0,
    blend_distance: 1,
    spherical_harmonics: coefficients,
  });
  const high = create_irradiance_probe({
    ...low,
    id: probe_id("high"),
    priority: 1,
  });
  const weights = blend_probe_weights([low, high], vec3(0, 0, 0), 2);
  assertEquals(weights.map(({ probe }) => probe), [high.id, low.id]);
  assertAlmostEquals(weights[0].weight + weights[1].weight, 1, 1e-12);
  assertAlmostEquals(weights[0].weight, 2 / 3, 1e-12);
  const extreme = create_irradiance_probe({
    ...high,
    id: probe_id("extreme"),
    priority: Number.MAX_SAFE_INTEGER,
  });
  const extreme_weights = blend_probe_weights(
    [low, extreme],
    vec3(0, 0, 0),
    2,
  );
  assertEquals(extreme_weights[0], { probe: extreme.id, weight: 1 });
  assertEquals(Number.isFinite(extreme_weights[1].weight), true);
});

Deno.test("probe invalidation distinguishes revisions from environment replacement", () => {
  const environment = environment_id("room");
  const original = create_reflection_probe({
    id: probe_id("reflection"),
    revision: 1,
    volume: aabb(vec3(-1, -1, -1), vec3(1, 1, 1)),
    priority: 0,
    blend_distance: 0,
    environment,
  });
  const revised = create_reflection_probe({ ...original, revision: 2 });
  assertEquals(
    probe_invalidations(
      [revised],
      new Map([[original.id, original]]),
      new Set(),
    ),
    [{ probe: revised.id, reason: "revision" }],
  );
  assertEquals(
    probe_invalidations(
      [original],
      new Map([[original.id, original]]),
      new Set([environment]),
    ),
    [{ probe: original.id, reason: "environment" }],
  );
});

Deno.test("exposure adaptation, atmosphere, and quality reduction are explicit inputs", () => {
  assertEquals(resolve_exposure({ type: "manual", ev100: 2 }, 0, 0, 1), {
    ev100: 2,
    multiplier: 0.25,
  });
  const transmittance = atmosphere_transmittance(
    {
      planet_center: vec3(0, 0, 0),
      planet_radius: 6_371_000,
      atmosphere_height: 8_000,
      rayleigh_scattering: linear_rgb(0.00001, 0.00002, 0.00004),
      mie_scattering: linear_rgb(0.000005, 0.000005, 0.000005),
      mie_anisotropy: 0.8,
      ground_albedo: linear_rgb(0.2, 0.2, 0.2),
      sun: point_light("unused").id,
    },
    0,
    1_000,
  );
  assertEquals(transmittance.r < 1, true);
  const reduced = reduce_lighting_quality(lighting_quality(), 1);
  assertEquals(reduced.quality.maximum_lights, 8);
  assertEquals(reduced.quality.shadows.resolution_scale, 0.25);
  assertEquals(reduced.quality.shadows.cached_update_interval_multiplier, 4);
  assertEquals(
    reduced.reductions.some(({ field }) => field === "maximum_lights"),
    true,
  );
  assertThrows(
    () =>
      reduce_lighting_quality({
        ...lighting_quality(),
        environment_roughness_levels: 1,
      }, 0),
    Error,
    "must be within [2, 16]",
  );
  assertThrows(
    () =>
      resolve_exposure({ type: "manual", ev100: -Number.MAX_VALUE }, 0, 0, 0),
    Error,
    "produces invalid multiplier",
  );
});

Deno.test("compatibility, clustered-forward, and deferred consume the identical plan", () => {
  const plan = build_lighting_plan({
    revision: 1,
    view: camera_view(),
    camera_revision: 1,
    caster_revision: 1,
    frame_index: 0,
    lights: [point_light("lamp", { position: vec3(0, 0, -4), range: 10 })],
    environments: new Map(),
    exposure: { type: "manual", ev100: 0 },
    metered_ev100: 0,
    previous_ev100: 0,
    delta_seconds: 1 / 60,
    quality: lighting_quality(),
    quality_pressure: 0,
    visibility_revision: 7,
  });
  assertStrictEquals(lighting_plan_for_path(plan, "compatibility"), plan);
  assertStrictEquals(lighting_plan_for_path(plan, "clustered_forward"), plan);
  assertStrictEquals(lighting_plan_for_path(plan, "deferred"), plan);
  assertEquals(plan.visibility_revision, 7);
});
