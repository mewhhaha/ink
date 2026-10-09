import { assertEquals } from "@std/assert";
import { checkGi } from "./gi_checks.ts";
import { createRenderer } from "./renderer.ts";

const adapter = await navigator.gpu?.requestAdapter();
Deno.test({
  name:
    "brush lightmaps illuminate a shadowed room and rebake deterministically after edits",
  ignore: !adapter,
  async fn() {
    const renderer = await createRenderer();
    const errors: string[] = [];
    renderer.device.addEventListener(
      "uncapturederror",
      (e) => errors.push((e as GPUUncapturedErrorEvent).error.message),
    );
    try {
      const result = await checkGi(renderer);
      console.log({
        bakeMs: result.bakeMs,
        darkPixels: result.darkPixels,
        brightness: result.brightness,
      });
      assertEquals(errors, []);
    } finally {
      renderer.dispose();
    }
  },
});
