import { mat4, quat, type Vec4 } from "@ink/geometry";
import { lookAtCamera } from "./camera.ts";
import { defaultEnvironment } from "./environment.ts";
import type {
  Draw,
  Overlays,
  PixelData,
  Renderer,
  RenderScene,
} from "./types.ts";

const plane = (
  entity: number,
  z: number,
  color: Vec4,
  alphaMode: Draw["alphaMode"] = "opaque",
): Draw => ({
  entity,
  mesh: "builtin:plane",
  matrix: mat4.compose([0, 0, z], quat.fromEuler([90, 0, 0]), [3, 3, 3]),
  color,
  alphaMode,
  doubleSided: true,
  roughness: 1,
  metallic: 0,
  emissive: [0, 0, 0, 1],
  emissiveStrength: 0,
  normalStrength: 1,
  uvScale: [1, 1],
  castShadows: true,
});
const pixel = (
  image: PixelData,
  x: number,
  y: number,
) => [
  ...image.data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 3),
];
function near(actual: number[], expected: number[], label: string) {
  if (actual.some((value, i) => Math.abs(value - expected[i]) > 2)) {
    throw new Error(`${label}: ${actual}, expected ${expected}`);
  }
}

/** Physical linear blending, sorted geometry, holes in picking, and empty sky. */
export async function checkTransparency(renderer: Renderer) {
  const scene: RenderScene = {
    draws: [],
    brushes: [],
    lights: [],
    cameras: [],
    matrices: new Map(),
    bounds: null,
    environment: defaultEnvironment(),
  };
  const view = renderer.createView({ width: 192, height: 192 });
  const camera = lookAtCamera([0, 0, 4], [0, 0, 0], {
    orthographic: true,
    size: 4,
  }, 1);
  const options: Overlays = {
    still: true,
    shading: "unlit",
    background: [0, 0, 0, 1],
  };
  const read = async () => {
    view.render(scene, camera, options);
    return await view.readPixels();
  };
  try {
    const red = plane(1, 1, [1, 0, 0, 0.5], "blend");
    const blue = plane(2, 0.5, [0, 0, 1, 0.5], "blend");
    const green = plane(3, 0, [0, 1, 0, 1]);
    scene.draws = [red, blue, green];
    const blended = await read();
    near(pixel(blended, 96, 96), [188, 137, 137], "back-to-front linear blend");
    scene.draws.reverse();
    const reversed = await read();
    if (!blended.data.every((value, i) => value === reversed.data[i])) {
      throw new Error("transparent rendering depends on entity order");
    }
    red.matrix = plane(1, 0.25, red.color).matrix;
    near(
      pixel(await read(), 96, 96),
      [137, 137, 188],
      "moving through another surface changes blend order",
    );
    green.matrix = plane(3, 2, green.color).matrix;
    near(
      pixel(await read(), 96, 96),
      [0, 255, 0],
      "opaque depth hides translucency",
    );

    scene.draws = [plane(1, 1, [1, 0, 0, 0.25], "additive")];
    options.background = [0.2, 0.2, 0.2, 1];
    near(
      pixel(await read(), 96, 96),
      [145, 51, 51],
      "additive light over a flat empty background",
    );
    scene.draws.push(plane(2, 0.5, [0, 0, 1, 0.25], "additive"));
    near(
      pixel(await read(), 96, 96),
      [145, 51, 145],
      "additive layers preserve the background",
    );

    const texels = new Uint8Array(4 * 4 * 4);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        texels.set([255, 255, 255, x < 2 ? 0 : 255], (y * 4 + x) * 4);
      }
    }
    renderer.assets.setTexture("cutout", { width: 4, height: 4, data: texels });
    const cutout = {
      ...plane(1, 1, [1, 0, 0, 1], "mask"),
      texture: "cutout",
      alphaCutoff: 0.5,
    };
    scene.draws = [cutout, plane(3, 0, [0, 1, 0, 1])];
    const holes = await read();
    near(pixel(holes, 60, 96), [0, 255, 0], "alpha cutout reveals geometry");
    near(pixel(holes, 132, 96), [255, 0, 0], "opaque part of the cutout");
    if (
      (await view.pick(60, 96))?.entity !== 3 ||
      (await view.pick(132, 96))?.entity !== 1
    ) throw new Error("picking ignores alpha cutouts");
    view.render(
      scene,
      lookAtCamera([0, 0, -4], [0, 0, 1], { orthographic: true, size: 4 }, 1),
      options,
    );
    if ((await view.pick(96, 96))?.entity !== 3) {
      throw new Error("double-sided surfaces cannot be picked from behind");
    }
    return blended;
  } finally {
    view.dispose();
  }
}
