import { assertMatch } from "@std/assert";
import { platformer_shader_source } from "./platformer_shader.ts";

Deno.test("platformer shader owns its authored colour and toon-lighting policy", () => {
  assertMatch(platformer_shader_source, /ink_toon_lighting/);
  assertMatch(platformer_shader_source, /color_and_emissive/);
  assertMatch(platformer_shader_source, /@group\(0\) @binding\(3\)/);
});
