import { assertEquals } from "@std/assert";
import { createRenderer } from "./renderer.ts";
import { checkAnimation } from "./animation_checks.ts";

const adapter = await navigator.gpu?.requestAdapter();
Deno.test({
  name:
    "GPU skinning and morph targets match CPU surfaces, shadows, AO, selection and picks after rewind",
  ignore: !adapter,
  async fn() {
    const renderer = await createRenderer();
    const errors: string[] = [];
    renderer.device.addEventListener(
      "uncapturederror",
      (e) => errors.push((e as GPUUncapturedErrorEvent).error.message),
    );
    try {
      await checkAnimation(renderer);
      await renderer.device.queue.onSubmittedWorkDone();
      assertEquals(errors, []);
    } finally {
      renderer.dispose();
    }
  },
});
