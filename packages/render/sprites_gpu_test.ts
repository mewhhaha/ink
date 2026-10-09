import { assertEquals } from "@std/assert";
import { createRenderer } from "./renderer.ts";
import { checkSprites } from "./sprites_checks.ts";

const adapter = await navigator.gpu?.requestAdapter();
Deno.test({
  name:
    "2D sprites, tile maps, text, lights and shadows draw crisp pixels beside 3D",
  ignore: !adapter,
  async fn() {
    const renderer = await createRenderer();
    const errors: string[] = [];
    renderer.device.addEventListener(
      "uncapturederror",
      (event) => errors.push((event as GPUUncapturedErrorEvent).error.message),
    );
    try {
      await checkSprites(renderer);
      assertEquals(errors, []);
    } finally {
      renderer.dispose();
    }
  },
});
