import {
  assertAlmostEquals,
  assertEquals,
  assertGreater,
  assertThrows,
} from "@std/assert";
import {
  canonical_material_record,
  create_material_definition,
  default_pbr_parameters,
} from "@ink/materials/canonical.ts";
import { linear_rgb, linear_rgba } from "@ink/materials/color.ts";
import { material_definition_id } from "@ink/materials/identity.ts";
import { vec3 } from "@ink/math/vector.ts";
import { evaluate_direct_light, lambertian_diffuse } from "./brdf.ts";
import { light_id } from "./identity.ts";
import {
  create_light,
  incident_illuminance,
  spot_cone_attenuation,
} from "./light.ts";
import type { LightDefinition } from "./model.ts";
import { point_light } from "./test_fixtures.ts";

Deno.test("point illuminance follows inverse square distance before declared range falloff", () => {
  const light = point_light("lamp", { range: 1_000_000 });
  const at_two = incident_illuminance(light, vec3(0, 0, 2));
  const at_four = incident_illuminance(light, vec3(0, 0, 4));
  assertAlmostEquals(at_two.r / at_four.r, 4, 1e-12);
});

Deno.test("spot cones are full inside the inner angle and zero beyond the outer angle", () => {
  const light = create_light({
    ...point_light("spot.source"),
    id: light_id("spot"),
    type: "spot",
    direction: vec3(0, 0, -1),
    inner_angle_radians: 0.2,
    outer_angle_radians: 0.4,
  }) as Extract<LightDefinition, { type: "spot" }>;
  assertEquals(spot_cone_attenuation(light, vec3(0, 0, -2)), 1);
  assertEquals(spot_cone_attenuation(light, vec3(2, 0, 0)), 0);
});

Deno.test("invalid physical units fail with the light and field", () => {
  assertThrows(
    () => point_light("broken", { intensity_candela: -1 }),
    Error,
    "light broken intensity candela -1 must be finite and positive",
  );
  assertThrows(
    () =>
      create_light({
        ...point_light("broken-spot"),
        type: "spot",
        direction: vec3(0, 0, -1),
        inner_angle_radians: 0.1,
        outer_angle_radians: 0.2,
        source_radius: 2,
        range: 1,
      }),
    Error,
    "source radius 2 must be below range 1",
  );
  assertThrows(
    () =>
      create_light({ ...point_light("broken-type"), type: "laser" } as never),
    Error,
    'type "laser" is unsupported',
  );
  assertThrows(
    () =>
      create_light({
        ...point_light("broken-shadow"),
        shadow: {
          type: "dynamic",
          resolution: 512,
          depth_bias: 0,
          normal_bias: 0,
          filter: { type: "pcf", radius: 7 },
          update_interval_frames: 1,
        } as never,
      }),
    Error,
    "PCF radius 7 is unsupported",
  );
});

Deno.test("Lambertian and microfacet direct response uses canonical material energy", () => {
  const definition = create_material_definition({
    id: material_definition_id("matte"),
    revision: 0,
    parameters: {
      ...default_pbr_parameters(),
      base_color: linear_rgba(1, 0.5, 0.25, 1),
      perceptual_roughness: 0.5,
    },
    alpha: { type: "opaque" },
    sidedness: "front",
  });
  const material = canonical_material_record(definition);
  const diffuse = lambertian_diffuse(material.diffuse_color, 1);
  assertAlmostEquals(diffuse.r, 0.96 / Math.PI, 1e-12);
  const sun = create_light({
    id: light_id("sun"),
    revision: 0,
    type: "directional",
    color: linear_rgb(1, 1, 1),
    layers: 1,
    importance: 10,
    shadow: { type: "off" },
    direction: vec3(0, 0, -1),
    illuminance_lux: 1_000,
    angular_diameter_radians: 0.01,
  });
  const response = evaluate_direct_light(
    material,
    sun,
    vec3(0, 0, 0),
    vec3(0, 0, 1),
    vec3(0, 0, 1),
  );
  assertGreater(response.diffuse.r, 300);
  assertGreater(response.specular.r, 0);
  assertEquals(response.clearcoat, linear_rgb(0, 0, 0));
});
