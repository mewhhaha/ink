import { browser } from "../tests/browser-support.ts";
import { browserVersion, setupBrowser } from "./browser.ts";
import { summary, writeReport } from "./report.ts";

let width = 1920;
let height = 1080;
const dimensions = Deno.args.filter((arg) => arg !== "--hardware");
if (dimensions[0]) width = Number(dimensions[0]);
if (dimensions[1]) height = Number(dimensions[1]);
if (
  ![width, height].every((value) =>
    Number.isInteger(value) && value > 0 && value <= 4096
  )
) throw new RangeError("Pass width height (1..4096)");
let backend = "Chromium Vulkan SwiftShader (software)";
let gpu: "hardware" | "software" = "software";
if (Deno.args.includes("--hardware")) {
  backend = "Chromium WebGPU (hardware requested)";
  gpu = "hardware";
}
const page = await browser("/tests/gpu-browser.html", 1100, 800, { gpu });
try {
  await page.waitFor("globalThis.inkReady === true");
  const report = await page.evaluate(
    `import('/tests/gpu-bench.ts').then(module => module.benchmark(${width}, ${height}))`,
    60_000,
  );
  const measured = report as {
    results: Record<string, { queueWallMs: number[]; gpuMs: number[] }>;
  };
  const results: Record<string, unknown> = {};
  for (const [name, samples] of Object.entries(measured.results)) {
    const result: Record<string, unknown> = {
      queueWallMs: summary(samples.queueWallMs),
    };
    if (samples.gpuMs.length) result.gpuMs = summary(samples.gpuMs);
    results[name] = result;
  }
  await writeReport("gpu", {
    backend,
    ...report as object,
    results,
  }, await browserVersion(await setupBrowser()));
} finally {
  await page.dispose();
}
