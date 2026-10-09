import { assertEquals } from "@std/assert";
import { checkGi, checkReflections } from "./gi_checks.ts";
import { createRenderer } from "./renderer.ts";
import { encodePng } from "./png.ts";
import type { PixelData } from "./types.ts";

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
        reflectionPixels: (await checkReflections(renderer)).reflectionPixels,
      });
      assertEquals(errors, []);
    } catch (error) {
      console.error(errors);
      const frames = (error as { frames?: PixelData[] }).frames ?? [];
      for (let i = 0; i < frames.length; i++) {
        const p = frames[i];
        await Deno.mkdir("tmp", { recursive: true });
        await Deno.writeFile(
          `tmp/gi-failure-${i}.png`,
          await encodePng(p.width, p.height, p.data),
        );
      }
      throw error;
    } finally {
      renderer.dispose();
    }
  },
});
