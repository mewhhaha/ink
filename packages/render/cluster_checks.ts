/** A reproducible many-light scene and pixel oracle, shared by both GPU hosts. */
import { mat4, quat, type Vec3 } from "@ink/geometry";
import { lookAtCamera } from "./camera.ts";
import { defaultEnvironment } from "./environment.ts";
import type {
  Draw,
  LightDraw,
  Overlays,
  Renderer,
  RenderScene,
} from "./types.ts";

export function clusterScene(count = 512): RenderScene {
  const colors: Vec3[] = [[1, 0.15, 0.04], [0.04, 0.7, 1], [0.5, 1, 0.06], [
    0.7,
    0.12,
    1,
  ]];
  const lights: LightDraw[] = Array.from({ length: count }, (_, i) => ({
    entity: i + 1000,
    kind: i % 3 === 0 ? "spot" : "point",
    color: colors[i % colors.length],
    intensity: 14,
    range: 4,
    angle: 75,
    shadows: false,
    softness: 1,
    position: [
      (i % 32 - 15.5) * 3,
      1.2 + (i % 2) * 0.4,
      (Math.floor(i / 32) - 7.5) * 3,
    ],
    direction: [0, -1, 0],
  }));
  const shape = (
    entity: number,
    mesh: string,
    position: Vec3,
    scale: Vec3,
  ): Draw => ({
    entity,
    mesh,
    matrix: mat4.compose(position, quat.identity(), scale),
    color: [0.65, 0.65, 0.65, 1],
    roughness: 0.65,
    metallic: 0.15,
    emissive: [0, 0, 0, 1],
    emissiveStrength: 0,
    normalStrength: 1,
    uvScale: [1, 1],
    castShadows: false,
  });
  return {
    matrices: new Map(
      lights.map((
        light,
      ) => [
        light.entity,
        mat4.compose(light.position, quat.fromEuler([-90, 0, 0]), [1, 1, 1]),
      ]),
    ),
    draws: [
      shape(1, "builtin:plane", [0, 0, 0], [102, 1, 56]),
      ...Array.from({ length: 128 }, (_, i) =>
        shape(i + 2, "builtin:sphere", [
          (i % 16 - 7.5) * 6,
          0.8,
          (Math.floor(i / 16) - 3.5) * 6,
        ], [1.6, 1.6, 1.6])),
    ],
    brushes: [],
    lights,
    cameras: [],
    bounds: null,
    environment: {
      ...defaultEnvironment(),
      sky: "flat",
      skyColor: [0.02, 0.025, 0.04, 1],
      ambient: 0.05,
      ambientOcclusion: 0,
      bloom: 0,
      autoExposure: false,
      grain: 0,
      vignette: 0,
      fogDensity: 0,
    },
  };
}

export function clusterCamera(aspect: number, orthographic = false) {
  return lookAtCamera([22, 38, 42], [0, 0, 0], {
    fov: 62,
    far: 180,
    size: 68,
    orthographic,
  }, aspect);
}

export async function checkClusters(
  renderer: Renderer,
  scale = 1,
  progress: (stage: string) => void = () => {},
) {
  const scene = clusterScene();
  const view = renderer.createView({
    width: Math.round(481 * scale),
    height: Math.round(271 * scale),
  });
  const options: Overlays = { still: true, quality: "low" };
  let picture;
  try {
    for (const orthographic of [false, true]) {
      progress(`${orthographic ? "orthographic" : "perspective"} reference`);
      const camera = clusterCamera(view.width / view.height, orthographic);
      view.render(scene, camera, { ...options, clustered: false });
      const reference = await view.readPixels();
      progress(`${orthographic ? "orthographic" : "perspective"} clustered`);
      view.render(scene, camera, options);
      if (view.stats.lights !== 512 || !view.stats.clusters) {
        throw new Error("512 lights were not clustered");
      }
      picture = await view.readPixels();
      let worst = 0, changed = 0;
      for (let i = 0; i < picture.data.length; i++) {
        const difference = Math.abs(picture.data[i] - reference.data[i]);
        worst = Math.max(worst, difference);
        if (difference > 1) changed++;
      }
      if (worst > 1) {
        throw Object.assign(
          new Error(
            `${
              orthographic ? "orthographic" : "perspective"
            } clustering changed ${changed} channels, worst ${worst}`,
          ),
          { frames: [reference, picture] },
        );
      }
      view.render(scene, camera, options);
      const repeat = await view.readPixels();
      if (!picture.data.every((value, i) => value === repeat.data[i])) {
        throw new Error("clustered still capture is not deterministic");
      }
      scene.lights[511].position = [0, 1, 0];
      view.resize(Math.round(641 * scale), Math.round(359 * scale), 1);
    }
    scene.lights = scene.lights.slice(0, 8);
    progress("release cluster resources");
    view.render(scene, clusterCamera(view.width / view.height), options);
    await view.readPixels();
    if (view.stats.clusters) {
      throw new Error("small light lists retain cluster resources");
    }
    return picture!;
  } finally {
    view.dispose();
  }
}
