/** GPU regressions shared by Deno and the Chromium renderer smoke test. */
import {
  extractScene,
  lookAtCamera,
  type Overlays,
  type PixelData,
  type Renderer,
  type RenderScene,
} from "./mod.ts";
import { catalog, fixtureWorld } from "./fixture.ts";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function same(a: PixelData, b: PixelData, label: string) {
  check(a.width === b.width && a.height === b.height, `${label}: dimensions`);
  let worst = 0;
  for (let i = 0; i < a.data.length; i++) {
    worst = Math.max(worst, Math.abs(a.data[i] - b.data[i]));
  }
  // Software rasterizers can round a few channels differently by one level.
  if (worst > 1) {
    throw Object.assign(
      new Error(`${label}: pixels differ by up to ${worst}`),
      {
        frames: [a, b],
      },
    );
  }
}

function sceneFor(renderer: Renderer): RenderScene {
  const texture = {
    width: 1,
    height: 1,
    data: new Uint8Array([180, 180, 180, 255]),
  };
  renderer.assets.setTexture("textures/checker.png", texture);
  renderer.assets.setTexture("textures/missing.png", texture);
  return extractScene(fixtureWorld(), catalog);
}

const camera = (width: number, height: number) =>
  lookAtCamera([5.5, 4.2, 8.5], [0, 0.6, -0.5], { fov: 50 }, width / height);

export interface LifecycleCheck {
  name: string;
  run(renderer: Renderer): Promise<PixelData>;
}

export const lifecycleChecks: LifecycleCheck[] = [
  {
    name: "still captures update sky lighting immediately",
    async run(renderer) {
      const scene = sceneFor(renderer);
      const options: Overlays = {
        still: true,
        quality: "low",
        environment: { sky: "flat", skyColor: [0.8, 0.1, 0.1, 1] },
      };
      const view = renderer.createView({ width: 192, height: 128 });
      const fresh = renderer.createView({ width: 192, height: 128 });
      try {
        view.render(scene, camera(192, 128), options);
        await view.readPixels();
        const before = view.stats.environmentBakes;
        options.environment = { sky: "flat", skyColor: [0.1, 0.1, 0.8, 1] };
        view.render(scene, camera(192, 128), options);
        check(
          view.stats.environmentBakes === before + 1,
          "a still capture reused the previous sky's lighting",
        );
        const changed = await view.readPixels();
        fresh.render(scene, camera(192, 128), options);
        same(changed, await fresh.readPixels(), "changed sky vs fresh view");
        return changed;
      } finally {
        view.dispose();
        fresh.dispose();
      }
    },
  },
  {
    name: "first frames survive view recreation and resizing",
    async run(renderer) {
      const scene = sceneFor(renderer);
      const view = renderer.createView({ width: 192, height: 128 });
      let result: PixelData | undefined;
      try {
        for (const quality of ["low", "high"] as const) {
          const options: Overlays = {
            still: true,
            quality,
            selection: [2],
            grid: { plane: "xz", spacing: 1 },
            environment: { grain: 0.2, bloom: 0.15, autoExposure: true },
          };
          // Include odd sizes, a one-pixel target and repeated allocations.
          for (
            const [width, height] of [
              [192, 128],
              [127, 79],
              [1, 1],
              [192, 128],
              [127, 79],
              [192, 128],
            ]
          ) {
            view.resize(width, height, 1);
            const cam = camera(width, height);
            view.render(scene, cam, options);
            const first = await view.readPixels();
            check(
              first.width === width && first.height === height,
              "resize dimensions",
            );
            view.render(scene, cam, options);
            same(
              first,
              await view.readPixels(),
              `${quality} ${width}x${height} first frame`,
            );
            const fresh = renderer.createView({ width, height });
            try {
              fresh.render(scene, cam, options);
              same(
                first,
                await fresh.readPixels(),
                `${quality} ${width}x${height} fresh view`,
              );
            } finally {
              fresh.dispose();
            }
            result = first;
          }
        }
        return result!;
      } finally {
        view.dispose();
      }
    },
  },
  {
    name: "local shadow textures follow active lights and quality",
    async run(renderer) {
      const scene = sceneFor(renderer);
      const point = {
        ...scene.lights.find((light) => light.kind === "point")!,
        shadows: true,
      };
      scene.lights = [point, {
        ...point,
        entity: 99,
        kind: "spot",
        position: [0, 5, 1],
        direction: [0, -1, 0],
        angle: 90,
      }];
      const device = renderer.device;
      const createTexture = device.createTexture;
      const textures: { label: string; width: number; destroyed: boolean }[] =
        [];
      device.createTexture = function (descriptor) {
        const texture = createTexture.call(this, descriptor);
        if (
          descriptor.label === "spot-shadow-atlas" ||
          descriptor.label === "point-shadow-cubes"
        ) {
          const record = {
            label: descriptor.label,
            width: texture.width,
            destroyed: false,
          };
          textures.push(record);
          const destroy = texture.destroy;
          texture.destroy = function () {
            record.destroyed = true;
            destroy.call(this);
          };
        }
        return texture;
      };
      const active = () => textures.filter((t) => !t.destroyed);
      const view = renderer.createView({ width: 192, height: 128 });
      const cam = camera(192, 128);
      const high: Overlays = { quality: "high", still: true };
      try {
        view.render(scene, cam, high);
        const original = await view.readPixels();
        check(active().length === 2, "both local shadow textures allocated");
        const highTextures = [...active()];
        // Downgrading without lights used to leave both high-quality maps alive.
        view.render({ ...scene, lights: [] }, cam, {
          quality: "low",
          still: true,
        });
        await view.readPixels();
        check(
          active().length === 0,
          "inactive shadow textures were retained after downgrade",
        );
        view.render(scene, cam, high);
        same(original, await view.readPixels(), "restored local shadows");
        check(
          highTextures.every((t) => t.destroyed),
          "old high-quality maps survive",
        );
        const restored = [...active()];
        view.render(scene, cam, { quality: "low", still: true });
        await view.readPixels();
        check(
          restored.every((t) => t.destroyed),
          "active maps were not replaced on downgrade",
        );
        check(
          active().length === 2 && active().every((t) => t.width <= 1024),
          "low-quality maps exceed budget",
        );
        view.render({ ...scene, lights: [point] }, cam, high);
        await view.readPixels();
        check(
          active().length === 1 && active()[0].label === "point-shadow-cubes",
          "unused spot atlas retained",
        );
        for (const shading of ["unlit", "wireframe"] as const) {
          view.render(scene, cam, high);
          await view.readPixels();
          view.render(scene, cam, { ...high, shading });
          await view.readPixels();
          check(active().length === 0, `${shading} retained local shadow maps`);
        }
        view.render(scene, cam, high);
        same(
          original,
          await view.readPixels(),
          "shadows after shading switches",
        );
        view.render({ ...scene, draws: [], brushes: [] }, cam, high);
        await view.readPixels();
        check(active().length === 0, "empty scene retained local shadow maps");
        return original;
      } finally {
        view.dispose();
        device.createTexture = createTexture;
      }
    },
  },
];
