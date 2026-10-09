import { assertEquals } from "@std/assert";
import { createRenderer } from "./mod.ts";
import { terrainChecks } from "./terrain_checks.ts";
import { encodePng } from "./png.ts";

const gpu = (globalThis.navigator as Navigator & { gpu?: GPU })?.gpu;
const adapter = gpu ? await gpu.requestAdapter().catch(() => null) : null;
const device = adapter ? await adapter.requestDevice() : undefined;
globalThis.addEventListener("unload", () => device?.destroy());

for (const [index, item] of terrainChecks.entries()) {
  Deno.test({
    name: item.name,
    ignore: !adapter,
    async fn() {
      const renderer = await createRenderer({
        device,
        assetBase: "file:///nowhere/",
      });
      const errors: string[] = [];
      renderer.device.addEventListener("uncapturederror", (event) => {
        errors.push((event as GPUUncapturedErrorEvent).error.message);
      });
      try {
        const picture = await item.run(renderer);
        await renderer.device.queue.onSubmittedWorkDone();
        assertEquals(errors, []);
        await Deno.mkdir("tmp", { recursive: true });
        await Deno.writeFile(
          `tmp/terrain-${index + 1}.png`,
          await encodePng(picture.width, picture.height, picture.data),
        );
      } finally {
        renderer.dispose();
      }
    },
  });
}
