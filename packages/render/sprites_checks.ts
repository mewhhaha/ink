/**
 * GPU checks of the 2D layer: crisp nearest-neighbour sprites, atlas frames,
 * flips, layers, tile maps, text, lighting with normal maps and tile shadows,
 * picking, depth against 3D, temporal anti-aliasing and render scale. They run
 * on real pixels with generated textures, so no files are needed.
 */
import { mat4 } from "@ink/geometry";
import { type Atlas, parseAtlas } from "@ink/schema";
import { lookAtCamera } from "./camera.ts";
import { defaultEnvironment } from "./environment.ts";
import { srgbToLinear } from "./gpu.ts";
import { linearToSrgb } from "./model.ts";
import type {
  Light2dDraw,
  Overlays,
  PixelData,
  Renderer,
  RenderScene,
  SpriteDraw,
  TextDraw,
  TilemapDraw,
} from "./types.ts";

const SIZE = 64;

type Rgb = [number, number, number];

function sheet() {
  // Three 16 x 16 cells: red, green with a blue 4 x 4 block, white.
  const w = 48, h = 16;
  const color = new Uint8Array(w * h * 4);
  const normal = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cell = Math.floor(x / 16);
      let c: Rgb = cell === 0
        ? [255, 0, 0]
        : cell === 1
        ? [0, 255, 0]
        : [255, 255, 255];
      if (cell === 1 && x - 16 < 4 && y < 4) c = [0, 0, 255];
      color.set([...c, 255], (y * w + x) * 4);
      // The red cell's surface leans toward +x; the others face the viewer.
      normal.set(
        cell === 0 ? [217, 128, 217, 255] : [128, 128, 255, 255],
        (y * w + x) * 4,
      );
    }
  }
  return { w, h, color, normal };
}

export const atlasText = JSON.stringify({
  image: "sheet.png",
  normals: "sheet_n.png",
  grid: { cell: [16, 16], columns: 3, rows: 1 },
  names: { red: 0, green: 1, white: 2 },
  tiles: { red: "solid", white: "oneway" },
});

const sprite = (
  entity: number,
  extra: Partial<SpriteDraw> = {},
): SpriteDraw => ({
  entity,
  order: entity,
  matrix: mat4.identity(),
  atlas: "sheet.atlas.json",
  frame: 1,
  anim: 0,
  animTime: 0,
  color: [1, 1, 1, 1],
  flipX: false,
  flipY: false,
  pivot: [0.5, 0.5],
  pixelsPerUnit: 16,
  layer: 0,
  ySort: false,
  lit: true,
  smooth: false,
  snap: false,
  ...extra,
});

const at = (x: number, y: number, z = 0) =>
  mat4.compose([x, y, z], [0, 0, 0, 1], [1, 1, 1]);

const lamp = (
  entity: number,
  x: number,
  y: number,
  extra: Partial<Light2dDraw> = {},
): Light2dDraw => ({
  entity,
  kind: "lamp",
  position: [x, y, 0],
  direction: [1, 0],
  color: [1, 1, 1],
  intensity: 1,
  radius: 12,
  falloff: 1,
  height: 1,
  angle: 60,
  shadows: false,
  ...extra,
});

const px = (image: PixelData, x: number, y: number): Rgb => [
  image.data[(y * image.width + x) * 4],
  image.data[(y * image.width + x) * 4 + 1],
  image.data[(y * image.width + x) * 4 + 2],
];

function expect(actual: Rgb, wanted: Rgb, label: string, tolerance = 2) {
  if (actual.some((v, i) => Math.abs(v - wanted[i]) > tolerance)) {
    throw new Error(`${label}: got ${actual}, wanted ${wanted}`);
  }
}

const screen = (x: number, y: number): [number, number] => [
  SIZE / 2 + Math.round(x * 16),
  SIZE / 2 - Math.round(y * 16),
];

const brightness = (c: Rgb) => c[0] + c[1] + c[2];

export interface SpriteResults {
  pictures: Record<string, PixelData>;
}

export async function checkSprites(renderer: Renderer): Promise<SpriteResults> {
  const { w, h, color, normal } = sheet();
  renderer.assets.setTexture("sheet.png", { width: w, height: h, data: color });
  renderer.assets.setTexture("sheet_n.png", {
    width: w,
    height: h,
    data: normal,
  });
  const atlases = (renderer.assets as unknown as {
    atlases: { set(path: string, atlas: Atlas): void };
  }).atlases;
  atlases.set("sheet.atlas.json", parseAtlas(atlasText, "sheet.atlas.json"));

  const scene: RenderScene = {
    draws: [],
    brushes: [],
    lights: [],
    cameras: [],
    matrices: new Map(),
    bounds: null,
    environment: defaultEnvironment(),
  };
  const view = renderer.createView({ width: SIZE, height: SIZE });
  const camera = lookAtCamera([0, 0, 4], [0, 0, 0], {
    orthographic: true,
    size: 4,
  }, 1);
  const options: Overlays = {
    still: true,
    shading: "unlit",
    background: [0, 0, 0, 1],
  };
  const read = async (overrides: Overlays = {}) => {
    view.render(scene, camera, { ...options, ...overrides });
    return await view.readPixels();
  };
  const pictures: Record<string, PixelData> = {};
  const set = (next: Partial<RenderScene>) => {
    scene.sprites = undefined;
    scene.tilemaps = undefined;
    scene.texts = undefined;
    scene.lights2d = undefined;
    scene.draws = [];
    Object.assign(scene, next);
  };
  try {
    // Wait for the sheet textures; the first frames may skip what is loading.
    set({ sprites: [sprite(1)] });
    await read();
    await renderer.assets.settled();

    // Nearest sampling keeps every texel: a 16 pixel sprite is one unit here.
    const crisp = await read();
    pictures.sprite = crisp;
    expect(px(crisp, ...screen(0, 0)), [255, 0, 0], "sprite centre");
    expect(px(crisp, 24, 32), [255, 0, 0], "first texel column");
    expect(px(crisp, 23, 32), [0, 0, 0], "the edge is exact, no blending");
    expect(px(crisp, 39, 32), [255, 0, 0], "last texel column");
    expect(px(crisp, 40, 32), [0, 0, 0], "past the last texel");

    // Frames and flips come from the atlas.
    set({ sprites: [sprite(1, { frame: 2 })] });
    const plain = await read();
    expect(px(plain, 25, 25), [0, 0, 255], "blue block, top left");
    expect(px(plain, 38, 25), [0, 255, 0], "green elsewhere");
    set({ sprites: [sprite(1, { frame: 2, flipX: true })] });
    const flipped = await read();
    expect(px(flipped, 38, 25), [0, 0, 255], "flipped block, top right");
    expect(px(flipped, 25, 25), [0, 255, 0], "flipped away from the left");
    set({ sprites: [sprite(1, { frame: 2, flipY: true })] });
    expect(px(await read(), 25, 38), [0, 0, 255], "vertical flip");

    // The tint multiplies, and layers decide who is on top.
    set({
      sprites: [
        sprite(1, { frame: 1, layer: 1 }),
        sprite(2, { frame: 2, layer: 0 }),
      ],
    });
    expect(px(await read(), 32, 32), [255, 0, 0], "higher layer on top");
    set({
      sprites: [
        sprite(1, { frame: 1, layer: 0 }),
        sprite(2, { frame: 2, layer: 1, color: [0.5, 1, 1, 1] }),
      ],
    });
    expect(px(await read(), 38, 38), [0, 255, 0], "tint over a lower layer");
    expect(
      px(await read(), 25, 25),
      [0, 0, 255],
      "the tint multiplies blue too",
    );

    // Tile maps: one quad, one texture lookup per pixel.
    const map: TilemapDraw = {
      entity: 7,
      order: 7,
      matrix: at(-1, -1),
      tileset: "sheet.atlas.json",
      width: 2,
      height: 2,
      cell: [1, 1],
      color: [1, 1, 1, 1],
      layer: 0,
      lit: true,
      occluder: false,
      data: [1, 2, 2, 1],
    };
    set({ tilemaps: [map] });
    const tiles = await read();
    pictures.tiles = tiles;
    expect(px(tiles, ...screen(-0.5, -0.5)), [255, 0, 0], "tile (0, 0)");
    expect(px(tiles, ...screen(0.5, -0.5)), [0, 255, 0], "tile (1, 0)");
    expect(px(tiles, ...screen(-0.5, 0.5)), [0, 255, 0], "tile (0, 1)");
    expect(px(tiles, ...screen(0.5, 0.5)), [255, 0, 0], "tile (1, 1)");
    expect(px(tiles, 4, 4), [0, 0, 0], "outside the map");
    map.data = [0, 2, 2, 1];
    expect(px(await read(), ...screen(-0.5, -0.5)), [0, 0, 0], "an empty tile");
    map.data = [1, 2, 2, 1];

    // Picking happens on the CPU against the same quads.
    await read();
    const hit = await view.pick(...screen(0.5, -0.5));
    if (hit?.entity !== 7 || hit.cell?.join() !== "1,0") {
      throw new Error(`tile pick: ${JSON.stringify(hit)}`);
    }
    set({ sprites: [sprite(3)] });
    await read();
    if ((await view.pick(32, 32))?.entity !== 3) throw new Error("sprite pick");
    if (await view.pick(4, 4)) throw new Error("picked empty space");

    // Text from the distance field font, anti-aliased and deterministic.
    const text: TextDraw = {
      entity: 4,
      order: 4,
      matrix: at(0, 0),
      text: "HI",
      size: 2,
      color: [1, 1, 1, 1],
      align: "center",
      outline: 0,
      outlineColor: [0, 0, 0, 1],
      layer: 0,
    };
    set({ texts: [text] });
    const words = await read();
    pictures.text = words;
    const lit = (image: PixelData) => {
      let n = 0;
      for (let i = 0; i < image.data.length; i += 4) {
        if (image.data[i] > 128) n++;
      }
      return n;
    };
    if (lit(words) < 80 || lit(words) > 1500) {
      throw new Error(`text covers ${lit(words)} pixels`);
    }
    const again = await read();
    if (!words.data.every((v, i) => v === again.data[i])) {
      throw new Error("text is not deterministic");
    }
    text.outline = 0.6;
    text.outlineColor = [1, 0, 0, 1];
    const outlined = await read();
    let red = 0;
    for (let i = 0; i < outlined.data.length; i += 4) {
      if (outlined.data[i] > 200 && outlined.data[i + 1] < 40) red++;
    }
    if (red < 40) throw new Error(`the outline is missing (${red} px)`);
    text.align = "right";
    // Right aligned text ends at the entity: nothing to its right.
    if (px(await read(), 40, 32).some((v) => v !== 0)) {
      throw new Error("right aligned text runs past its anchor");
    }

    // Light: an ambient light scales colour in linear space, and a light
    // with a normal map brightens surfaces facing it.
    const half = Math.round(linearToSrgb(srgbToLinear(1) * 0.5) * 255);
    set({
      sprites: [sprite(1, { frame: 1 })],
      lights2d: [{
        ...lamp(5, 0, 0),
        kind: "ambient",
        intensity: 0.5,
      }],
    });
    expect(px(await read(), 32, 32), [half, 0, 0], "ambient light, linear");
    set({
      sprites: [sprite(1, { frame: 1, lit: false })],
      lights2d: [{ ...lamp(5, 0, 0), kind: "ambient", intensity: 0.1 }],
    });
    expect(px(await read(), 32, 32), [255, 0, 0], "unlit sprites ignore light");
    set({
      sprites: [sprite(1, { frame: 1 })],
      lights2d: [lamp(5, 3, 0, { radius: 20, falloff: 0.1 })],
    });
    const fromRight = brightness(px(await read(), 32, 32));
    set({
      sprites: [sprite(1, { frame: 1 })],
      lights2d: [lamp(5, -3, 0, { radius: 20, falloff: 0.1 })],
    });
    const fromLeft = brightness(px(await read(), 32, 32));
    if (fromRight < fromLeft + 60) {
      throw new Error(
        `normal map: lit from its side ${fromRight}, from the other ${fromLeft}`,
      );
    }

    // Tile shadows: a solid tile (the red frame) between lamp and probe.
    const wall: TilemapDraw = {
      ...map,
      entity: 8,
      matrix: at(-3, -0.5),
      width: 6,
      height: 1,
      occluder: true,
      data: [0, 0, 0, 1, 0, 0],
    };
    const probes = [
      sprite(1, { frame: 3, matrix: at(-1, 0), pixelsPerUnit: 64 }),
      sprite(2, { frame: 3, matrix: at(1.5, 0), pixelsPerUnit: 64 }),
    ];
    const withLamp = (shadows: boolean) => {
      set({
        tilemaps: [wall],
        sprites: probes,
        lights2d: [lamp(5, -1.8, 0, { radius: 20, falloff: 0.3, shadows })],
      });
      return read();
    };
    const open = await withLamp(false);
    const shadowed = await withLamp(true);
    pictures.shadows = shadowed;
    const [left, right] = [screen(-1, 0), screen(1.5, 0)];
    if (brightness(px(open, ...right)) < 60) {
      throw new Error("no light behind the wall");
    }
    if (brightness(px(shadowed, ...right)) > 12) {
      throw new Error(`the wall casts no shadow: ${px(shadowed, ...right)}`);
    }
    if (brightness(px(shadowed, ...left)) < 60) {
      throw new Error("the shadow reaches the lit side");
    }

    // 2D content alongside 3D: depth decides, and the picture is whole.
    set({
      sprites: [sprite(1, { frame: 1, matrix: at(0, 0, -2) })],
      draws: [{
        entity: 9,
        mesh: "builtin:cube",
        matrix: mat4.compose([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]),
        color: [0, 0, 1, 1],
        roughness: 1,
        metallic: 0,
        emissive: [0, 0, 0, 1],
        emissiveStrength: 0,
        normalStrength: 1,
        uvScale: [1, 1],
        castShadows: false,
      }],
    });
    const behind = await read();
    expect(
      px(behind, 32, 32),
      [0, 0, 255],
      "a cube hides a sprite behind it",
      8,
    );
    set({
      sprites: [sprite(1, { frame: 1, matrix: at(0, 0, 2) })],
      draws: scene.draws,
    });
    expect(
      px(await read(), 32, 32),
      [255, 0, 0],
      "a sprite in front of the cube",
    );
    scene.draws = [];

    // Temporal accumulation and render scale leave 2D pixel-exact.
    set({
      sprites: [sprite(1, { frame: 2 })],
      tilemaps: [{ ...map, matrix: at(-3, -3), occluder: false }],
    });
    const reference = await read();
    for (let i = 0; i < 12; i++) {
      view.render(scene, camera, { ...options, still: false, temporal: true });
    }
    view.render(scene, camera, {
      ...options,
      still: false,
      temporal: true,
      renderScale: 0.5,
    });
    const accumulated = await view.readPixels();
    if (view.stats.renderWidth !== SIZE) {
      throw new Error("2D content was rendered below output resolution");
    }
    for (const [x, y] of [[25, 25], [38, 38], [28, 36], [10, 50], [50, 12]]) {
      expect(
        px(accumulated, x, y),
        px(reference, x, y),
        `crisp under TAA at ${x},${y}`,
      );
    }
    const stats = view.stats.sprites;
    if (stats !== 2) throw new Error(`expected 2 items, drew ${stats}`);

    // Atlas and texture hot reload: the next frame uses the new data.
    atlases.set(
      "sheet.atlas.json",
      parseAtlas(
        JSON.stringify({
          image: "sheet.png",
          frames: { first: [16, 0, 16, 16] },
        }),
        "sheet.atlas.json",
      ),
    );
    set({ sprites: [sprite(1, { frame: 1 })] });
    expect(px(await read(), 32, 32), [0, 255, 0], "a changed atlas redraws");
    const recolored = new Uint8Array(color);
    for (let y = 4; y < 16; y++) {
      for (let x = 16; x < 32; x++) {
        recolored.set([255, 255, 0, 255], (y * w + x) * 4);
      }
    }
    renderer.assets.setTexture("sheet.png", {
      width: w,
      height: h,
      data: recolored,
    });
    set({ sprites: [sprite(1, { frame: 1 })] });
    expect(px(await read(), 32, 32), [255, 255, 0], "a changed image redraws");
    return { pictures };
  } finally {
    view.dispose();
  }
}
