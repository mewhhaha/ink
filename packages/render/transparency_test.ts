import { assertEquals } from "@std/assert";
import { createRenderer } from "./renderer.ts";
import { checkTransparency } from "./transparency_checks.ts";
import { checkParticles } from "./particles_checks.ts";

const adapter = await navigator.gpu?.requestAdapter();
Deno.test({
  name:
    "transparency blends in linear HDR, sorts surfaces, respects depth and picks through cutouts",
  ignore: !adapter,
  async fn() {
    const renderer = await createRenderer();
    const errors: string[] = [];
    renderer.device.addEventListener(
      "uncapturederror",
      (event) => errors.push((event as GPUUncapturedErrorEvent).error.message),
    );
    try {
      await checkTransparency(renderer);
      await checkParticles(renderer);
      assertEquals(errors, []);
    } finally {
      renderer.dispose();
    }
  },
});
