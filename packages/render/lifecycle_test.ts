import { assertEquals } from "@std/assert";
import { createRenderer } from "./mod.ts";
import { lifecycleChecks } from "./lifecycle_checks.ts";

const gpu = (globalThis.navigator as Navigator & { gpu?: GPU })?.gpu;
const adapter = gpu ? await gpu.requestAdapter().catch(() => null) : null;
for (const check of lifecycleChecks) {
  Deno.test({
    name: check.name,
    ignore: !adapter,
    async fn() {
      const renderer = await createRenderer();
      const errors: string[] = [];
      renderer.device.addEventListener("uncapturederror", (event) => {
        errors.push((event as GPUUncapturedErrorEvent).error.message);
      });
      try {
        await check.run(renderer);
        await renderer.device.queue.onSubmittedWorkDone();
        assertEquals(errors, []);
      } finally {
        renderer.dispose();
      }
    },
  });
}
