import { assertEquals } from "@std/assert";
import { createRenderer } from "./renderer.ts";
import {
  checkTemporal,
  checkTemporalDeformation,
  checkTemporalNoise,
} from "./temporal_checks.ts";

const adapter = await navigator.gpu?.requestAdapter();
Deno.test({
  name:
    "temporal upscaling preserves moving edges, rejects disocclusions, and resets on seek/cut/resize",
  ignore: !adapter,
  async fn() {
    const renderer = await createRenderer();
    const errors: string[] = [];
    renderer.device.addEventListener(
      "uncapturederror",
      (e) => errors.push((e as GPUUncapturedErrorEvent).error.message),
    );
    try {
      const result = await checkTemporal(renderer);
      console.log({
        halfError: result.halfError,
        motionError: result.motionError,
        deformationError: await checkTemporalDeformation(renderer),
        noiseVarianceRatio: (await checkTemporalNoise(renderer)).ratio,
      });
      await renderer.device.queue.onSubmittedWorkDone();
      assertEquals(errors, []);
    } finally {
      renderer.dispose();
    }
  },
});
