import { builtinMesh, mat4, quat } from "@ink/geometry";
import { lookAtCamera } from "./camera.ts";
import { defaultEnvironment } from "./environment.ts";
import { srgbToLinear } from "./gpu.ts";
import { linearToSrgb } from "./model.ts";
import type {
  Camera,
  Draw,
  Overlays,
  PixelData,
  Renderer,
  RenderMeshData,
  RenderScene,
} from "./types.ts";

export function temporalScene(): RenderScene {
  const draws: Draw[] = Array.from({ length: 24 }, (_, i) => ({
    entity: i + 1,
    mesh: "builtin:cube",
    matrix: mat4.compose(
      [(i % 6 - 2.5) * 0.7, (Math.floor(i / 6) - 1.5) * 0.65, 0],
      quat.fromEuler([20, 10, 27]),
      [i % 2 ? 0.025 : 0.45, 0.5, 0.15],
    ),
    color: i % 3 ? [0.8, 0.85, 0.9, 1] : [0.8, 0.25, 0.1, 1],
    roughness: 0.7,
    metallic: 0,
    normalStrength: 1,
    uvScale: [1, 1],
    emissive: [0, 0, 0, 1],
    emissiveStrength: 0,
    castShadows: true,
  }));
  return {
    tick: 0,
    draws,
    brushes: [],
    lights: [],
    cameras: [],
    matrices: new Map(),
    bounds: null,
    environment: {
      ...defaultEnvironment(),
      sky: "flat",
      skyColor: [0.06, 0.07, 0.09, 1],
      grain: 0,
      autoExposure: false,
      bloom: 0,
      ambientOcclusion: 0,
      vignette: 0,
      fogDensity: 0,
    },
  };
}

function downsample(picture: PixelData): PixelData {
  const width = picture.width / 2,
    height = picture.height / 2,
    data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let channel = 0; channel < 3; channel++) {
        let sum = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            sum += srgbToLinear(
              picture
                .data[
                  ((y * 2 + dy) * picture.width + x * 2 + dx) * 4 + channel
                ] / 255,
            );
          }
        }
        data[(y * width + x) * 4 + channel] = Math.round(
          linearToSrgb(sum / 4) * 255,
        );
      }
      data[(y * width + x) * 4 + 3] = 255;
    }
  }
  return { width, height, data };
}

function meanError(a: PixelData, b: PixelData) {
  let error = 0;
  for (let i = 0; i < a.data.length; i++) {
    if (i % 4 !== 3) error += Math.abs(a.data[i] - b.data[i]);
  }
  return error / (a.width * a.height * 3);
}

/** Tests image behavior rather than a particular temporal implementation. */
export async function checkTemporal(renderer: Renderer) {
  const width = 240, height = 160;
  const scene = temporalScene();
  const camera = (x = 0) =>
    lookAtCamera([x, 0, 5], [x, 0, 0], { fov: 40, far: 30 }, width / height);
  const view = renderer.createView({ width, height });
  const reference = renderer.createView({
    width: width * 2,
    height: height * 2,
  });
  const options: Overlays = {
    temporal: true,
    shading: "unlit",
    background: [0.04, 0.05, 0.07, 1],
    renderScale: 0.5,
  };
  const render = async (at: Camera, more: Overlays = {}) => {
    view.render(scene, at, { ...options, ...more });
    await renderer.device.queue.onSubmittedWorkDone();
  };
  const oracle = async (at: Camera) => {
    reference.render(scene, at, {
      ...options,
      temporal: false,
      renderScale: 1,
      still: true,
    });
    return downsample(await reference.readPixels());
  };
  try {
    for (let i = 0; i < 24; i++) await render(camera());
    const half = await view.readPixels(), native = await oracle(camera());
    const halfError = meanError(half, native);
    if (
      view.stats.temporalFrames < 8 || view.stats.renderWidth !== width / 2 ||
      half.width !== width
    ) throw new Error("temporal upscaling did not retain output resolution");
    if (halfError > 8) {
      throw Object.assign(
        new Error(
          `half-resolution reconstruction differs from supersampling by ${
            halfError.toFixed(2)
          } levels`,
        ),
        { frames: [half, native] },
      );
    }
    for (let i = 1; i <= 24; i++) {
      scene.tick = i;
      await render(camera(i * 0.01));
    }
    const moving = await view.readPixels(),
      motionError = meanError(moving, await oracle(camera(0.24)));
    if (motionError > 9) {
      throw new Error(
        `moving camera smeared edges: ${motionError.toFixed(2)} levels`,
      );
    }
    // A large moving foreground reveals the contrasting background in one frame.
    scene.draws = [{
      ...scene.draws[0],
      entity: 100,
      color: [0.1, 0.8, 0.2, 1],
      matrix: mat4.compose([0, 0, 1], quat.identity(), [1, 1, 1]),
    }];
    for (let i = 0; i < 12; i++) await render(camera());
    const picked = await view.pick(width / 2, height / 2);
    if (picked?.entity !== 100) {
      throw new Error("scaled temporal picking missed the current geometry");
    }
    scene.draws[0].matrix = mat4.compose([2, 0, 1], quat.identity(), [1, 1, 1]);
    await render(camera());
    const exposed = await view.readPixels();
    const center = (height / 2 * width + width / 2) * 4;
    const expected = [10, 13, 18];
    if (expected.some((v, i) => Math.abs(v - exposed.data[center + i]) > 2)) {
      throw new Error("disocclusion retained a green ghost");
    }
    // A seek and an explicit cut must start exactly like a fresh view.
    scene.tick = 0;
    await render(camera());
    if (view.stats.temporalFrames !== 1) {
      throw new Error("rewind retained temporal history");
    }
    const reset = await view.readPixels();
    const fresh = renderer.createView({ width, height });
    try {
      fresh.render(scene, camera(), options);
      if (meanError(reset, await fresh.readPixels()) !== 0) {
        throw new Error("reset history differs from a fresh temporal view");
      }
    } finally {
      fresh.dispose();
    }
    await render(camera(8));
    if (view.stats.temporalFrames !== 1) {
      throw new Error("camera cut retained history");
    }
    view.resize(241, 137, 1);
    await render(camera());
    const resized = await view.readPixels();
    if (
      resized.width !== 241 || resized.height !== 137 ||
      Number(view.stats.temporalFrames) !== 1
    ) throw new Error("odd resize did not reset and upscale");
    await render(camera(), { still: true });
    const still = await view.readPixels();
    await render(camera());
    await render(camera(0.1));
    await render(camera(), { still: true });
    if (
      meanError(still, await view.readPixels()) !== 0 ||
      Number(view.stats.temporalFrames) !== 0
    ) throw new Error("still capture depends on previous temporal frames");
    return { native, half, moving, halfError, motionError };
  } finally {
    view.dispose();
    reference.dispose();
  }
}

/** The same motion expressed three ways must produce the same accumulated
 * image: object transforms, skeletal deformation and morph targets. */
export async function checkTemporalDeformation(renderer: Renderer) {
  const mesh: RenderMeshData = { ...builtinMesh("builtin:cube")! };
  const vertices = mesh.positions.length / 3;
  mesh.joints = new Uint32Array(vertices * 4);
  mesh.weights = new Float32Array(vertices * 4);
  const delta = new Float32Array(mesh.positions.length);
  for (let i = 0; i < vertices; i++) {
    mesh.weights[i * 4] = 1;
    delta[i * 3 + 1] = 0.6;
  }
  mesh.targets = [{ positions: delta }];
  renderer.assets.setMesh("test:temporal-deformation", mesh);
  const source = temporalScene();
  const body = { ...source.draws[0], matrix: mat4.identity() };
  const rigid = { ...source, draws: [body] };
  const deformed = {
    ...source,
    draws: [{ ...body, mesh: "test:temporal-deformation" }],
  };
  const a = renderer.createView({ width: 160, height: 160 });
  const b = renderer.createView({ width: 160, height: 160 });
  const camera = lookAtCamera([0, 0, 4], [0, 0, 0], { fov: 40 }, 1);
  const options: Overlays = {
    shading: "unlit",
    temporal: true,
    renderScale: 0.5,
  };
  try {
    let error = 0;
    for (let i = 0; i < 32; i++) {
      const x = Math.sin(i * 0.2) * 0.7, weight = Math.cos(i * 0.12);
      body.matrix = mat4.compose([x, weight * 0.6, 0], quat.identity(), [
        1,
        1,
        1,
      ]);
      deformed.draws[0].skin = [
        mat4.compose([x, 0, 0], quat.identity(), [1, 1, 1]),
      ];
      deformed.draws[0].morphWeights = [weight];
      a.render(rigid, camera, options);
      b.render(deformed, camera, options);
      if (i >= 16) {
        error = Math.max(
          error,
          meanError(await a.readPixels(), await b.readPixels()),
        );
      } else await renderer.device.queue.onSubmittedWorkDone();
    }
    if (error > 0.15) {
      throw new Error(
        `deformed motion disagrees with rigid motion by ${error}`,
      );
    }
    return error;
  } finally {
    a.dispose();
    b.dispose();
  }
}

/** Grain should converge on a flat surface; accumulation must not simply
 * reproduce the current noisy frame. Shadows and AO use the same frame index. */
export async function checkTemporalNoise(renderer: Renderer) {
  const scene = temporalScene();
  scene.draws = [{
    ...scene.draws[0],
    matrix: mat4.compose([0, 0, 0], quat.identity(), [8, 8, 1]),
    color: [0.5, 0.5, 0.5, 1],
  }];
  scene.environment!.grain = 0.4;
  const camera = lookAtCamera([0, 0, 4], [0, 0, 0], { fov: 40 }, 1);
  const a = renderer.createView({ width: 96, height: 96 });
  const b = renderer.createView({ width: 96, height: 96 });
  const variation = (pixels: PixelData) => {
    const values: number[] = [];
    for (let y = 24; y < 72; y++) {
      for (let x = 24; x < 72; x++) values.push(pixels.data[(y * 96 + x) * 4]);
    }
    const mean = values.reduce((a, b) => a + b) / values.length;
    return values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  };
  try {
    for (let i = 0; i < 24; i++) {
      a.render(scene, camera, { temporal: true });
      b.render(scene, camera);
      await renderer.device.queue.onSubmittedWorkDone();
    }
    const accumulated = await a.readPixels(), raw = await b.readPixels();
    const ratio = variation(accumulated) / variation(raw);
    if (!(ratio < 0.5)) {
      throw new Error(
        `temporal noise did not converge: variance ratio ${ratio}`,
      );
    }
    return { accumulated, raw, ratio };
  } finally {
    a.dispose();
    b.dispose();
  }
}
