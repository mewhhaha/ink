import { assertAlmostEquals, assertEquals } from "@std/assert";
import { linear_rgb } from "@ink/materials/color.ts";
import { vec3 } from "@ink/math/vector.ts";
import {
  build_clustered_light_plan,
  cluster_index_for_fragment,
} from "./clusters.ts";
import { light_id } from "./identity.ts";
import { create_light } from "./light.ts";
import type { LightDefinition } from "./model.ts";
import { build_shadow_plan, cascade_partitions } from "./shadows.ts";
import {
  camera_view,
  lighting_quality,
  point_light,
  shadow_policy,
} from "./test_fixtures.ts";

function directional(id: string, importance: number): LightDefinition {
  return create_light({
    id: light_id(id),
    revision: 0,
    type: "directional",
    color: linear_rgb(1, 1, 1),
    layers: 1,
    importance,
    shadow: { type: "off" },
    direction: vec3(0, -1, -1),
    illuminance_lux: 10_000,
    angular_diameter_radians: 0.01,
  });
}

Deno.test("cluster overflow keeps the highest-importance lights deterministically", () => {
  const view = camera_view();
  const plan = build_clustered_light_plan({
    view,
    lights: [
      directional("low", 1),
      directional("high", 3),
      directional("middle", 2),
    ],
    grid: {
      x_slices: 2,
      y_slices: 1,
      z_slices: 2,
      maximum_lights_per_cluster: 2,
    },
    maximum_lights: 3,
  });
  for (const cluster of plan.clusters) {
    assertEquals(cluster.lights, [light_id("high"), light_id("middle")]);
    assertEquals(cluster.overflow, [light_id("low")]);
  }
  assertEquals(plan.cluster_overflow_count, 4);
  assertEquals(
    cluster_index_for_fragment(plan, 639, 359, 100, 640, 360, 0.1, 100),
    3,
  );
});

Deno.test("cascade partitions interpolate between uniform and logarithmic splits", () => {
  assertEquals(cascade_partitions(1, 100, 2, 0), [50.5, 100]);
  const logarithmic = cascade_partitions(1, 100, 2, 1);
  assertAlmostEquals(logarithmic[0], 10, 1e-12);
  assertEquals(logarithmic[1], 100);
});

Deno.test("cascade partitions remain finite across extreme valid ranges", () => {
  const splits = cascade_partitions(Number.MIN_VALUE, Number.MAX_VALUE, 4, 1);
  assertEquals(splits.every(Number.isFinite), true);
  assertEquals(splits.at(-1), Number.MAX_VALUE);
});

Deno.test("logical atlas degrades an atomic point-shadow group before overflowing", () => {
  const light = point_light("bulb", {
    shadow: shadow_policy("dynamic"),
    range: 20,
  });
  const plan = build_shadow_plan({
    view: camera_view(),
    camera_revision: 1,
    caster_revision: 2,
    frame_index: 0,
    lights: [light],
    quality: lighting_quality().shadows,
  });
  assertEquals(plan.views.length, 6);
  assertEquals(plan.views.map(({ atlas }) => atlas.size), [
    256,
    256,
    256,
    256,
    256,
    256,
  ]);
  assertEquals(plan.invalidations, [{
    light: light.id,
    action: "render",
    reason: "dynamic",
  }]);
});

Deno.test("cached shadows invalidate on revisions and otherwise retain their rendered frame", () => {
  const light = point_light("cached", { shadow: shadow_policy("cached") });
  const first = build_shadow_plan({
    view: camera_view(),
    camera_revision: 1,
    caster_revision: 1,
    frame_index: 0,
    lights: [light],
    quality: lighting_quality().shadows,
  });
  const reused = build_shadow_plan({
    view: camera_view(),
    camera_revision: 2,
    caster_revision: 1,
    frame_index: 1,
    lights: [light],
    quality: lighting_quality().shadows,
    previous_cache: first.cache,
  });
  assertEquals(reused.invalidations, [{ light: light.id, action: "reuse" }]);
  const changed = build_shadow_plan({
    view: camera_view(),
    camera_revision: 2,
    caster_revision: 2,
    frame_index: 2,
    lights: [light],
    quality: lighting_quality().shadows,
    previous_cache: reused.cache,
  });
  assertEquals(changed.invalidations[0].reason, "caster_revision");
});

Deno.test("directional caches invalidate for camera cascades and quality signatures", () => {
  const sun = create_light({
    ...directional("cached.sun", 10),
    shadow: shadow_policy("cached"),
  });
  const quality = lighting_quality().shadows;
  const first = build_shadow_plan({
    view: camera_view(),
    camera_revision: 1,
    caster_revision: 1,
    frame_index: 0,
    lights: [sun],
    quality,
  });
  const camera_changed = build_shadow_plan({
    view: camera_view(),
    camera_revision: 2,
    caster_revision: 1,
    frame_index: 1,
    lights: [sun],
    quality,
    previous_cache: first.cache,
  });
  assertEquals(camera_changed.invalidations[0].reason, "camera_cascade");
  const quality_changed = build_shadow_plan({
    view: camera_view(),
    camera_revision: 2,
    caster_revision: 1,
    frame_index: 2,
    lights: [sun],
    quality: { ...quality, resolution_scale: 0.5 },
    previous_cache: camera_changed.cache,
  });
  assertEquals(quality_changed.invalidations[0].reason, "quality");
});
