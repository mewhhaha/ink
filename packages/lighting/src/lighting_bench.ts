import { aabb } from "@ink/geometry/shapes.ts";
import { linear_rgb } from "@ink/materials/color.ts";
import { vec3 } from "@ink/math/vector.ts";
import { build_clustered_light_plan } from "./experimental/clusters.ts";
import { prefilter_environment } from "./experimental/environment.ts";
import { environment_id, probe_id } from "./identity.ts";
import { incident_illuminance } from "./light.ts";
import {
  blend_probe_weights,
  create_irradiance_probe,
} from "./experimental/probes.ts";
import { build_shadow_plan } from "./experimental/shadows.ts";
import {
  camera_view,
  lighting_quality,
  point_light,
  shadow_policy,
} from "./test_fixtures.ts";

const view = camera_view();
const lights = Array.from(
  { length: 256 },
  (_, index) =>
    point_light(`bench.${index}`, {
      position: vec3(
        (index % 16) - 8,
        Math.floor(index / 16) - 8,
        -10 - index % 8,
      ),
      range: 6,
      importance: 256 - index,
    }),
);

Deno.bench("evaluate 256 point-light assignments", () => {
  let total = 0;
  for (const light of lights) {
    total += incident_illuminance(light, vec3(0, 0, -10)).r;
  }
  if (!Number.isFinite(total)) {
    throw new Error("reference light assignment became non-finite");
  }
});

Deno.bench("build 16x9x24 clusters for 256 lights", () => {
  build_clustered_light_plan({
    view,
    lights,
    grid: {
      x_slices: 16,
      y_slices: 9,
      z_slices: 24,
      maximum_lights_per_cluster: 64,
    },
    maximum_lights: 256,
  });
});

const shadow_lights = Array.from(
  { length: 16 },
  (_, index) =>
    point_light(`shadow.${index}`, {
      position: vec3(index, 0, -10),
      shadow: shadow_policy("dynamic"),
    }),
);

Deno.bench("build logical shadow plan for 16 point lights", () => {
  build_shadow_plan({
    view,
    camera_revision: 1,
    caster_revision: 1,
    frame_index: 1,
    lights: shadow_lights,
    quality: {
      ...lighting_quality().shadows,
      atlas_size: 4096,
      maximum_shadowed_lights: 16,
    },
  });
});

const coefficients = Array.from({ length: 9 }, () => vec3(1, 1, 1));
const probes = Array.from(
  { length: 128 },
  (_, index) =>
    create_irradiance_probe({
      id: probe_id(`probe.${index}`),
      revision: 0,
      volume: aabb(vec3(-2, -2, -2), vec3(2, 2, 2)),
      priority: index % 4,
      blend_distance: 1,
      spherical_harmonics: coefficients,
    }),
);

Deno.bench("select and blend 128 irradiance probes", () => {
  blend_probe_weights(probes, vec3(0, 0, 0), 8);
});

const environment_pixels = Array.from(
  { length: 32 * 16 },
  (_, index) => linear_rgb(0.1 + index % 7 * 0.02, 0.2, 0.4),
);

Deno.bench("prefilter a 32x16 environment into 6 roughness levels", () => {
  prefilter_environment({
    id: environment_id("benchmark"),
    revision: 1,
    width: 32,
    height: 16,
    pixels: environment_pixels,
  }, 6);
});
