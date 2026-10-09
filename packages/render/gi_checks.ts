import { boxBrush, mat4, type Vec3 } from "@ink/geometry";
import {
  defineSchema,
  type SceneEntity,
  sceneToWorld,
  standard,
} from "@ink/schema";
import { extractScene } from "./extract.ts";
import { lookAtCamera } from "./camera.ts";
import { defaultEnvironment } from "./environment.ts";
import type { PixelData, Renderer } from "./types.ts";

export function giScene() {
  const schema = defineSchema({
    components: {
      transform: standard.transform,
      brush: standard.brush,
    },
  });
  const entities: SceneEntity[] = [];
  const box = (min: Vec3, max: Vec3) =>
    entities.push({
      id: entities.length + 1,
      components: {
        brush: {
          faces: boxBrush(min, max).map((f) => ({
            ...f,
            color: [0.8, 0.8, 0.8, 1],
          })),
        },
      },
    });
  box([-4, -0.2, -4], [4, 0, 4]);
  box([-4, 4, -4], [4, 4.2, 4]);
  box([-4, 0, -4.2], [4, 4, -4]);
  box([-4.2, 0, -4], [-4, 4, 4]);
  box([4, 0, -4], [4.2, 4, 4]);
  box([-0.1, 0, -4], [0.1, 2.5, 4]);
  const catalog = { assets: {} };
  const scene = extractScene(
    sceneToWorld(schema, { ink: 1, entities }, catalog).world,
    catalog,
  );
  scene.environment = {
    ...defaultEnvironment(),
    sky: "flat",
    skyColor: [0, 0, 0, 1],
    ambient: 0,
    indirect: 1,
    ambientOcclusion: 0,
    exposure: 0,
    autoExposure: false,
    grain: 0,
    bloom: 0,
    vignette: 0,
    shadowDistance: 30,
  };
  scene.lights = [{
    entity: 20,
    kind: "point",
    position: [2, 1.5, -1],
    color: [1, 0.8, 0.5],
    intensity: 20,
    range: 12,
    angle: 45,
    direction: [0, -1, 0],
    softness: 0,
    shadows: true,
  }];
  return scene;
}

function mean(a: PixelData, b: PixelData) {
  let difference = 0;
  for (let i = 0; i < a.data.length; i++) {
    if (i % 4 !== 3) difference += Math.abs(a.data[i] - b.data[i]);
  }
  return difference / (a.width * a.height * 3);
}

export async function checkGi(renderer: Renderer) {
  const scene = giScene();
  const camera = lookAtCamera([-3, 2.8, 7], [-1.5, 1.2, -0.8], {
    fov: 50,
    far: 30,
  }, 1.5);
  const view = renderer.createView({ width: 240, height: 160 });
  const fresh = renderer.createView({ width: 240, height: 160 });
  try {
    view.render(scene, camera, { still: true, environment: { indirect: 0 } });
    const direct = await view.readPixels();
    const start = performance.now();
    for (let i = 0; i < 16; i++) {
      view.render(scene, camera);
      await renderer.device.queue.onSubmittedWorkDone();
    }
    const bakeMs = performance.now() - start;
    const baked = await view.readPixels();
    if (
      view.stats.lightmapSamples !== 32 || view.stats.pendingWork ||
      view.stats.lightmapCharts !== 36
    ) {
      throw new Error("lightmaps did not finish incrementally");
    }
    // The left room has no ambient light and is behind the partition. Indirect
    // paths via the ceiling must illuminate surfaces that direct shadows hide.
    let dark = 0, gained = 0;
    for (let i = 0; i < direct.data.length; i += 4) {
      if (direct.data[i] < 5 && baked.data[i] > 12) {
        dark++;
        gained += baked.data[i];
      }
    }
    if (dark < 1000) {
      throw new Error(`too few shadowed pixels received bounce light: ${dark}`);
    }
    fresh.render(scene, camera, { still: true });
    const oracle = await fresh.readPixels();
    if (mean(baked, oracle) > 0.01) {
      throw new Error(
        `progressive bake differs from still: ${mean(baked, oracle)}`,
      );
    }
    // Edits change the blocker, trigger a new bake and change the picture.
    scene.brushes[5] = {
      ...scene.brushes[5],
      matrix: mat4.compose([0, 1, 0], [0, 0, 0, 1], [1, 1, 1]),
    };
    view.render(scene, camera);
    if (Number(view.stats.lightmapSamples) !== 2 || !view.stats.pendingWork) {
      throw new Error("brush edit did not invalidate the bake");
    }
    view.render(scene, camera, { still: true });
    const edited = await view.readPixels();
    if (mean(edited, baked) < 2) {
      throw new Error("brush rebake did not change illumination");
    }
    scene.brushes[5] = { ...scene.brushes[5], matrix: mat4.identity() };
    view.render(scene, camera, { still: true });
    if (mean(await view.readPixels(), oracle) !== 0) {
      throw new Error("undo changed deterministic lightmap pixels");
    }
    view.render(scene, camera, { shading: "unlit" });
    if (
      Number(view.stats.lightmapCharts) !== 0 ||
      Number(view.stats.lightmapSamples) !== 0
    ) throw new Error("unlit view retained bake resources");
    return {
      direct,
      baked,
      edited,
      bakeMs,
      darkPixels: dark,
      brightness: gained / dark,
    };
  } finally {
    view.dispose();
    fresh.dispose();
  }
}
