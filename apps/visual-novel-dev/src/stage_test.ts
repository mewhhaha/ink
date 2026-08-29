import { assertEquals } from "@std/assert";
import { validate_simple3d_scene } from "@ink/rendering/simple3d.ts";
import { visual_novel_scene } from "./stage.tsx";

Deno.test("visual novel ending changes the authored station signal", () => {
  const choice = visual_novel_scene(0, false);
  const ending = visual_novel_scene(0, true);
  validate_simple3d_scene(choice);
  validate_simple3d_scene(ending);

  assertEquals(
    choice.objects.find(({ id }) => id === "signal")?.material.emissive,
    [8, 0.18, 0.04],
  );
  assertEquals(
    ending.objects.find(({ id }) => id === "signal")?.material.emissive,
    [0.2, 7, 0.8],
  );
});
