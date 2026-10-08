import { assertEquals } from "@std/assert";
import { createRenderer } from "./renderer.ts";
import { checkClusters } from "./cluster_checks.ts";

const adapter = await navigator.gpu?.requestAdapter();
Deno.test({
  name:
    "512 clustered point/spot lights match reference pixels after camera, light and size changes",
  ignore: !adapter,
  async fn() {
    const renderer = await createRenderer();
    const errors: string[] = [];
    renderer.device.addEventListener(
      "uncapturederror",
      (event) => errors.push((event as GPUUncapturedErrorEvent).error.message),
    );
    try {
      await checkClusters(renderer);
      await renderer.device.queue.onSubmittedWorkDone();
      assertEquals(errors, []);
    } finally {
      renderer.dispose();
    }
  },
});
