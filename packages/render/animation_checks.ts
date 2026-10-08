/** Deformation oracle shared by native WebGPU and Chromium: GPU morphing and
 * eight-weight skinning must agree with independently deformed CPU geometry. */
import { builtinMesh, mat4, quat, type Vec3 } from "@ink/geometry";
import { lookAtCamera } from "./camera.ts";
import { defaultEnvironment } from "./environment.ts";
import { skinMesh } from "./model.ts";
import type {
  Draw,
  Overlays,
  PixelData,
  Renderer,
  RenderMeshData,
  RenderScene,
} from "./types.ts";

function compare(actual: PixelData, expected: PixelData, name: string) {
  let changed = 0, sum = 0, worst = 0;
  for (let i = 0; i < actual.data.length; i++) {
    const delta = Math.abs(actual.data[i] - expected.data[i]);
    if (delta > 2) changed++;
    sum += delta;
    worst = Math.max(worst, delta);
  }
  // CPU/GPU rounding may move a subpixel edge, but cannot change a surface.
  if (
    changed > actual.width * actual.height * 0.006 ||
    sum / actual.data.length > 0.1
  ) {
    throw Object.assign(
      new Error(
        `${name}: ${changed} channels differ, worst ${worst}, mean ${
          sum / actual.data.length
        }`,
      ),
      { frames: [actual, expected] },
    );
  }
}

export async function checkAnimation(renderer: Renderer) {
  const mesh: RenderMeshData = { ...builtinMesh("builtin:sphere")! };
  const count = mesh.positions.length / 3;
  mesh.joints = new Uint32Array(count * 4);
  mesh.joints1 = new Uint32Array(count * 4);
  mesh.weights = new Float32Array(count * 4);
  mesh.weights1 = new Float32Array(count * 4);
  const delta = new Float32Array(mesh.positions.length);
  for (let i = 0; i < count; i++) {
    const y = mesh.positions[i * 3 + 1];
    const w = (y + 0.5) * 0.7;
    mesh.joints.set([0, 1, 0, 0], i * 4);
    mesh.joints1.set([2, 0, 0, 0], i * 4);
    mesh.weights.set([0.8 - w, w, 0, 0], i * 4);
    mesh.weights1.set([0.2, 0, 0, 0], i * 4);
    delta.set([y * 0.5, Math.max(0, y) * 0.7, y * y * 0.4], i * 3);
  }
  mesh.targets = [{ positions: delta }];
  renderer.assets.setMesh("test:skinned", mesh);
  const shape = (
    entity: number,
    mesh: string,
    position: Vec3,
    scale: Vec3,
  ): Draw => ({
    entity,
    mesh,
    matrix: mat4.compose(position, quat.identity(), scale),
    color: [0.3, 0.65, 0.9, 1],
    roughness: 0.7,
    metallic: 0.1,
    emissive: [0, 0, 0, 1],
    emissiveStrength: 0,
    normalStrength: 1,
    uvScale: [1, 1],
    castShadows: true,
  });
  const subject = shape(7, "test:skinned", [0, 1, 0], [1.4, 1.7, 1]);
  const first = [
    mat4.identity(),
    mat4.compose([0.45, 0.3, 0], quat.fromEuler([15, 0, -40]), [1.2, 0.9, 1]),
    mat4.compose([-0.3, 0.1, 0.2], quat.fromEuler([0, 20, 10]), [1, 1, 1]),
  ];
  subject.skin = first;
  subject.morphWeights = [0.7];
  const scene: RenderScene = {
    draws: [
      shape(1, "builtin:cube", [0, -2.5, 0], [20, 5, 20]),
      subject,
      shape(2, "builtin:cube", [10, 8, 10], [1, 1, 1]),
    ],
    matrices: new Map(),
    brushes: [],
    cameras: [],
    bounds: null,
    lights: [{
      entity: 9,
      kind: "directional",
      position: [0, 5, 5],
      direction: [-0.5, -1, -0.4],
      color: [1, 1, 1],
      intensity: 2,
      range: 30,
      angle: 40,
      shadows: true,
      softness: 0,
    }],
    environment: {
      ...defaultEnvironment(),
      sky: "flat",
      skyColor: [0.04, 0.04, 0.06, 1],
      grain: 0,
      autoExposure: false,
      bloom: 0,
      ambient: 0.3,
      ambientOcclusion: 1,
      shadowDistance: 30,
    },
  };
  const view = renderer.createView({ width: 192, height: 192 });
  const camera = lookAtCamera([3, 2.3, 5], [0, 0.9, 0], { fov: 40 }, 1);
  const render = async (options: Overlays) => {
    view.render(scene, camera, options);
    return await view.readPixels();
  };
  const setReference = () => {
    renderer.assets.setMesh(
      "test:deformed",
      skinMesh(mesh, subject.skin, subject.morphWeights),
    );
    scene.draws[1] = {
      ...subject,
      mesh: "test:deformed",
      skin: undefined,
      morphWeights: undefined,
    };
  };
  try {
    let picture: PixelData | undefined;
    for (
      const options of [
        { shading: "unlit" as const },
        { quality: "high" as const },
        { quality: "high" as const, debug: "ao" as const },
        { quality: "high" as const, selection: [7] },
      ]
    ) {
      scene.draws[1] = subject;
      const gpu = await render({ ...options, still: true });
      const hit = await view.pick(96, 96);
      if (hit?.entity !== 7) {
        throw new Error(
          "skinned character is not pickable at its rendered position",
        );
      }
      setReference();
      const cpu = await render({ ...options, still: true });
      compare(gpu, cpu, JSON.stringify(options));
      const cpuHit = await view.pick(96, 96);
      if (
        !cpuHit ||
        hit.point.some((v, i) => Math.abs(v - cpuHit.point[i]) > 1e-4)
      ) {
        throw new Error("skinning changed pick depth");
      }
      if (options.shading !== "unlit" && !options.debug && !options.selection) {
        picture = gpu;
      }
    }
    scene.draws[1] = subject;
    subject.skin = [
      mat4.identity(),
      mat4.compose([-0.8, 0.5, 0], quat.fromEuler([0, 30, 70]), [1, 1, 1]),
      mat4.identity(),
    ];
    subject.morphWeights = [-0.3];
    const changed = await render({ still: true, quality: "high" });
    if (changed.data.every((v, i) => v === picture!.data[i])) {
      throw new Error("skinning did not animate");
    }
    subject.skin = first;
    subject.morphWeights = [0.7];
    const rewind = await render({ still: true, quality: "high" });
    if (rewind.data.some((v, i) => v !== picture!.data[i])) {
      throw new Error("deformation or shadow/AO cache failed after rewind");
    }
    return picture!;
  } finally {
    view.dispose();
  }
}
