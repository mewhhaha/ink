import { assertEquals } from "@std/assert";
import { browser } from "./browser-support.ts";
Deno.test("WebGPU shaders compile and numerical image witnesses pass", async () => {
  const page = await browser("/tests/gpu-browser.html");
  try {
    await page.waitFor("globalThis.inkReady === true");
    const report = await page.evaluate<
      {
        compiled: boolean;
        cases: string[];
        timestamp: boolean;
        timings: unknown[];
        adapter: string;
      }
    >("gpuWitnesses()");
    assertEquals(report.compiled, true);
    assertEquals(report.cases.length, 8);
    let timer = "queue wall time";
    if (report.timestamp) timer = "GPU timestamp queries";
    console.log(`${report.cases.length} image witness groups; ${timer}.`);
    if (Deno.env.get("INK_GPU_REPORT")) console.log(JSON.stringify(report));
  } finally {
    await page.dispose();
  }
});
