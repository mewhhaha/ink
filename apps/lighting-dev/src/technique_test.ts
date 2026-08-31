import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import { reference_presentations } from "./scene.ts";
import {
  constrain_lighting_technique,
  lighting_render_technique,
  lighting_technique_preferences,
  select_lighting_technique,
  set_lighting_path_samples,
} from "./technique.ts";

Deno.test("lighting technique selection maps to one legal renderer variant", () => {
  const raster = lighting_technique_preferences(
    reference_presentations.cornell.technique_support,
    "raster",
    { maximum_bounces: 6, samples_per_frame: 4 },
  );
  const path_traced = select_lighting_technique(raster, "path_traced");

  assertEquals(lighting_render_technique(raster), {
    type: "raster",
    path: "clustered_forward",
    sample_count: 4,
    anti_aliasing: "none",
  });
  assertEquals(lighting_render_technique(path_traced), {
    type: "path_traced",
    samples_per_frame: 4,
    maximum_bounces: 6,
    render_scale: 1,
    denoiser: "edge_aware",
  });
});

Deno.test("lighting technique retains the chosen path sample count across toggles", () => {
  const initial = lighting_technique_preferences(
    reference_presentations["fog-room"].technique_support,
    "path_traced",
    { maximum_bounces: 6, samples_per_frame: 2 },
  );
  const sampled = set_lighting_path_samples(initial, 8);
  const raster = select_lighting_technique(sampled, "raster");
  const restored = select_lighting_technique(raster, "path_traced");

  assertEquals(initial.path_samples_per_frame, 2);
  assertEquals(restored.path_samples_per_frame, 8);
  assertEquals(lighting_render_technique(restored).type, "path_traced");
});

Deno.test("lighting technique rejects a path sample count outside the renderer contract", () => {
  for (const malformed of [0, 1.5, 65, Number.NaN]) {
    assertThrows(
      () =>
        lighting_technique_preferences(
          reference_presentations.cornell.technique_support,
          "path_traced",
          { maximum_bounces: 6, samples_per_frame: malformed },
        ),
      Error,
      `lighting path samples per frame ${malformed}`,
    );
  }
});

Deno.test("lighting technique rejects a path bounce limit outside the renderer contract", () => {
  for (const malformed of [0, 1.5, 17, Number.NaN]) {
    assertThrows(
      () =>
        lighting_technique_preferences(
          reference_presentations.cornell.technique_support,
          "path_traced",
          { maximum_bounces: malformed, samples_per_frame: 4 },
        ),
      Error,
      `lighting path maximum bounces ${malformed}`,
    );
  }
});

Deno.test("Bistro and Caldera cannot retain or select path tracing", () => {
  const path_traced = lighting_technique_preferences(
    reference_presentations.cornell.technique_support,
    "path_traced",
    { maximum_bounces: 6, samples_per_frame: 8 },
  );

  for (const reference of ["bistro", "caldera"] as const) {
    const constrained = constrain_lighting_technique(
      path_traced,
      reference_presentations[reference].technique_support,
    );

    assertEquals(constrained.selection, "raster");
    assertEquals(constrained.support.type, "raster_only");
    assertStrictEquals(
      select_lighting_technique(constrained, "path_traced"),
      constrained,
    );
  }
});

Deno.test("Cornell and Fog retain path tracing for renderer comparison", () => {
  const path_traced = lighting_technique_preferences(
    reference_presentations.cornell.technique_support,
    "path_traced",
    { maximum_bounces: 6, samples_per_frame: 8 },
  );
  const fog = constrain_lighting_technique(
    path_traced,
    reference_presentations["fog-room"].technique_support,
  );

  assertEquals(path_traced.selection, "path_traced");
  assertEquals(fog.selection, "path_traced");
  assertEquals(fog.support.type, "raster_and_path_traced");
});
