import { mat4 } from "@ink/geometry";
import { lookAtCamera } from "./camera.ts";
import { defaultEnvironment } from "./environment.ts";
import type { ParticleDraw, Renderer, RenderScene } from "./types.ts";

/** Shared native/browser check: the same tick survives arbitrary seeks and
 * new views. Each emitter uses a compute dispatch, including its depth sort. */
export async function checkParticles(renderer: Renderer) {
  const particle: ParticleDraw = {
    entity: 1,
    matrix: mat4.identity(),
    seed: 13,
    time: 1.2,
    rate: 80,
    count: 160,
    lifetime: 2,
    velocity: [0, 1.2, 0],
    spread: [0.7, 0.3, 0.7],
    gravity: [0, -0.2, 0],
    radius: 0.2,
    size: [0.3, 0.6],
    color: [1, 0.4, 0.05, 0.8],
    endColor: [0.2, 0.1, 0.1, 0],
    intensity: 2,
    blend: "blend",
    shape: "soft",
  };
  const scene: RenderScene = {
    draws: [],
    brushes: [],
    matrices: new Map(),
    lights: [],
    cameras: [],
    bounds: null,
    environment: defaultEnvironment(),
    particles: [particle],
  };
  const camera = lookAtCamera([3, 2.5, 5], [0, 1, 0], {}, 1);
  const view = renderer.createView({ width: 192, height: 192 });
  const options = {
    still: true,
    background: [0, 0, 0, 1] as [number, number, number, number],
  };
  const read = async () => {
    view.render(scene, camera, options);
    return await view.readPixels();
  };
  const equals = (a: Uint8Array, b: Uint8Array) =>
    a.every((v, i) => v === b[i]);
  try {
    const initial = await read();
    if (initial.data.filter((v, i) => i % 4 !== 3 && v > 8).length < 200) {
      throw new Error("GPU particles did not render");
    }
    if (view.stats.particles !== 160) {
      throw new Error("particle dispatch missing");
    }
    particle.time = 4.6;
    const later = await read();
    if (equals(initial.data, later.data)) {
      throw new Error("particles did not advance");
    }
    particle.time = 1.2;
    if (!equals(initial.data, (await read()).data)) {
      throw new Error("rewind changed particle pixels");
    }
    const fresh = renderer.createView({ width: 192, height: 192 });
    try {
      fresh.render(scene, camera, options);
      if (!equals(initial.data, (await fresh.readPixels()).data)) {
        throw new Error("new view changed particle pixels");
      }
    } finally {
      fresh.dispose();
    }
    particle.rate = 0;
    particle.time = 0.3;
    particle.blend = "additive";
    particle.shape = "spark";
    const burst = await read();
    if (burst.data.filter((v, i) => i % 4 !== 3 && v > 8).length < 50) {
      throw new Error("additive burst missing");
    }
    particle.time = 2.1;
    const expired = await read();
    if (expired.data.some((v, i) => i % 4 !== 3 && v > 1)) {
      throw new Error("expired burst still visible");
    }
    scene.particles = [];
    await read();
    if (Number(view.stats.particles) !== 0) {
      throw new Error("empty emitter retained GPU work");
    }
    return initial;
  } finally {
    view.dispose();
  }
}
