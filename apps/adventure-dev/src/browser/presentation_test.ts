import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  adventure_render_technique,
  initial_adventure_presentation_settings,
  select_adventure_technique,
} from "./presentation.ts";

Deno.test("adventure presentation starts in raster and selects portable path tracing", () => {
  assertEquals(
    adventure_render_technique(initial_adventure_presentation_settings),
    {
      type: "raster",
      path: "clustered_forward",
      sample_count: 4,
      anti_aliasing: "none",
    },
  );

  const path_traced = select_adventure_technique(
    initial_adventure_presentation_settings,
    "path_traced",
  );
  assertEquals(adventure_render_technique(path_traced), {
    type: "path_traced",
    samples_per_frame: 4,
    maximum_bounces: 4,
    render_scale: 1,
    denoiser: "edge_aware",
  });
  assertEquals(initial_adventure_presentation_settings.technique, "raster");
  assertEquals(path_traced.host_camera, {
    yaw_radians: 0,
    pitch_radians: 0,
    position_offset: [0, 0, 0],
    distance_scale: 1,
  });
});

Deno.test("reselecting an adventure technique retains its presentation state", () => {
  assertStrictEquals(
    select_adventure_technique(
      initial_adventure_presentation_settings,
      "raster",
    ),
    initial_adventure_presentation_settings,
  );
});
