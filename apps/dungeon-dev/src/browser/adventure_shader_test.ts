import { assertEquals, assertStringIncludes } from "@std/assert";
import { preview_sample_count } from "@ink/rendering/compatibility_renderer.ts";
import { adventure_shader_source } from "./adventure_shader.ts";

Deno.test("world surfaces project textures from all three world axes", () => {
  assertStringIncludes(
    adventure_shader_source,
    "let x_uv = world_position.zy * texture_scale;",
  );
  assertStringIncludes(
    adventure_shader_source,
    "let y_uv = world_position.xz * texture_scale;",
  );
  assertStringIncludes(
    adventure_shader_source,
    "let z_uv = world_position.xy * texture_scale;",
  );
  assertStringIncludes(
    adventure_shader_source,
    "texture_color = ink_sample_triplanar(",
  );
});

Deno.test("specialized surface modes retain their authored projections", () => {
  assertStringIncludes(
    adventure_shader_source,
    "let world_uv = input.world_position.xy * input.texture_scale.xy;",
  );
  assertStringIncludes(adventure_shader_source, "if (surface_mode == 1u)");
  assertStringIncludes(
    adventure_shader_source,
    "ink_upright_decal_uv(input.local_position)",
  );
  assertStringIncludes(adventure_shader_source, "if (surface_mode == 2u)");
});

Deno.test("local surfaces tile textures without depending on world translation", () => {
  assertStringIncludes(
    adventure_shader_source,
    "let local_uv = input.local_position.xy * input.texture_scale.xy;",
  );
  assertStringIncludes(adventure_shader_source, "if (surface_mode == 3u)");
  assertStringIncludes(
    adventure_shader_source,
    "model_sampler,\n      local_uv,\n      local_uv_dx,\n      local_uv_dy,",
  );
});

Deno.test("pixel decals select an atlas region without texture smoothing", () => {
  assertStringIncludes(
    adventure_shader_source,
    "upright_decal_position * input.texture_scale.xy",
  );
  assertStringIncludes(adventure_shader_source, "if (surface_mode == 4u)");
  assertStringIncludes(
    adventure_shader_source,
    "floor(upright_decal_uv * texture_size) + 0.5",
  );
});

Deno.test("preview lighting uses corrected normals and a modern color pipeline", () => {
  assertEquals(preview_sample_count, 4);
  assertStringIncludes(adventure_shader_source, "let normal_matrix = mat3x3f(");
  assertStringIncludes(adventure_shader_source, "fn ink_preview_illumination(");
  assertStringIncludes(adventure_shader_source, "let specular = pow(");
  assertStringIncludes(adventure_shader_source, "fn ink_aces_tone_map(");
  assertStringIncludes(adventure_shader_source, "let fog_amount = smoothstep(");
});
