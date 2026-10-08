/** Completed-frame timings (CPU preparation, submission and GPU), without vsync. */
import { createRenderer, encodePng, lookAtCamera } from "@ink/render";
import {
  checkClusters,
  clusterCamera,
  clusterScene,
} from "../packages/render/cluster_checks.ts";

const lowPower = Deno.args.includes("--low-power");
const adapter = await navigator.gpu.requestAdapter({
  powerPreference: lowPower ? "low-power" : "high-performance",
});
if (!adapter || adapter.info.isFallbackAdapter) {
  throw new Error("benchmark needs a hardware adapter");
}
const device = await adapter.requestDevice();
const renderer = await createRenderer({ device, quality: "high" });
const errors: string[] = [];
device.addEventListener(
  "uncapturederror",
  (event) => errors.push((event as GPUUncapturedErrorEvent).error.message),
);
try {
  await checkClusters(renderer);
  const width = 1280, height = 720;
  const scene = clusterScene();
  const view = renderer.createView({ width, height });
  const frames: Record<string, { median: number; p95: number }> = {};
  for (const mode of ["eight", "clustered", "reference"]) {
    const lights = scene.lights;
    if (mode === "eight") scene.lights = lights.slice(240, 248);
    const times: number[] = [];
    for (let i = 0; i < 70; i++) {
      const camera = lookAtCamera(
        [22 + Math.sin(i * 0.025), 38, 42],
        [0, 0, 0],
        { fov: 62, far: 180 },
        width / height,
      );
      const start = performance.now();
      view.render(scene, camera, {
        still: true,
        clustered: mode !== "reference",
      });
      await device.queue.onSubmittedWorkDone();
      if (i >= 10) times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    frames[mode] = { median: times[30], p95: times[57] };
    scene.lights = lights;
  }
  view.render(scene, clusterCamera(width / height), { still: true });
  const picture = await view.readPixels();
  if (errors.length) throw new Error(errors.join("\n"));
  const result = { adapter: adapter.info.description, width, height, frames };
  await Deno.mkdir("tmp", { recursive: true });
  const name = `tmp/clustered-native-${lowPower ? "integrated" : "discrete"}`;
  await Deno.writeTextFile(`${name}.json`, JSON.stringify(result, null, 2));
  await Deno.writeFile(
    `${name}.png`,
    await encodePng(width, height, picture.data),
  );
  console.log(JSON.stringify(result, null, 2));
  if (Deno.args.includes("--require-60") && frames.clustered.p95 > 1000 / 60) {
    throw new Error(
      `512 lights exceeded the 60 fps budget: p95 ${
        frames.clustered.p95.toFixed(2)
      } ms`,
    );
  }
} finally {
  renderer.dispose();
  device.destroy();
}
