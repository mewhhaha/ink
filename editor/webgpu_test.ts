import { assertAlmostEquals, assertEquals } from "@std/assert";
import { create_semantic_renderer, project_model_origin } from "./webgpu.ts";

Deno.test("perspective model projection matches the Blot semantic transform", () => {
  const [x, y] = project_model_origin(
    [-1_800_000, 0, 1_000_000],
    "perspective",
    960,
    540,
  );

  assertAlmostEquals(x, 328.8, 0.001);
  assertAlmostEquals(y, 270, 0.001);
});

Deno.test("orthographic model projection matches the Blot semantic transform", () => {
  const [x, y] = project_model_origin(
    [1_800_000, 0, 0],
    "orthographic",
    960,
    540,
  );

  assertAlmostEquals(x, 606, 0.001);
  assertAlmostEquals(y, 270, 0.001);
});

Deno.test("semantic rendering retains its degradation reason", () => {
  const renderer = create_semantic_renderer("no graphics adapter");

  assertEquals(renderer.mode, "semantic_only");
  assertEquals(renderer.unavailable_reason, "no graphics adapter");
  assertEquals(renderer.on_unavailable(() => {})(), undefined);
  assertEquals(renderer.dispose(), undefined);
});
