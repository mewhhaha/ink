/**
 * Generates the example's scenes: `main` is a finished little level, `blank`
 * the same hero, camera, lights and HUD over an empty map to build from. They
 * are starting points; open the project in the editor and keep building.
 *
 *   deno run -A examples/tiles/scripts/level.ts
 */
import { autotileMask, parseAtlas } from "@ink/schema";
import { stableJson } from "../../../packages/dev/paths.ts";

const assets = new URL("../assets/", import.meta.url);
const atlas = parseAtlas(
  await Deno.readTextFile(new URL("tiles.atlas.json", assets)),
  "tiles.atlas.json",
);
const tile = (name: string) => {
  const id = atlas.frames.findIndex((f) => f.name === name) + 1;
  if (id < 1) throw new Error(`no tile ${name}`);
  return id;
};
const ground = atlas.autotile.ground;

class Layer {
  cells: number[];
  constructor(readonly width: number, readonly height: number) {
    this.cells = new Array<number>(width * height).fill(0);
  }
  set(x: number, y: number, id: number) {
    if (x >= 0 && y >= 0 && x < this.width && y < this.height) {
      this.cells[y * this.width + x] = id;
    }
  }
  fill(x0: number, y0: number, x1: number, y1: number, id: number) {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) this.set(x, y, id);
    }
  }
}

interface Entity {
  id: number;
  name: string;
  parent?: number;
  components: Record<string, unknown>;
}

class Scene {
  entities: Entity[] = [];
  add(
    name: string,
    components: Record<string, unknown>,
    parent?: number,
  ) {
    const id = this.entities.length + 1;
    this.entities.push({ id, name, ...(parent ? { parent } : {}), components });
    return id;
  }
}

const at = (x: number, y: number, z = 0) => ({
  position: [x, y, z],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
});
const rotateZ = (degrees: number): [number, number, number, number] => [
  0,
  0,
  Math.sin((degrees * Math.PI) / 360),
  Math.cos((degrees * Math.PI) / 360),
];

/** The hero, camera, lights and HUD every level shares. */
function scaffold(
  width: number,
  height: number,
  layers: { back: Layer; solid: Layer; front: Layer },
  hero: [number, number],
) {
  const scene = new Scene();
  scene.add("Environment", {
    environment: {
      sky: "gradient",
      sky_color: [0.22, 0.4, 0.78, 1],
      horizon_color: [0.62, 0.8, 0.95, 1],
      ground_color: [0.2, 0.3, 0.5, 1],
      tonemap: "linear",
      bloom: 0,
      vignette: 0,
      ambient: 0,
    },
  });
  scene.add("Dusk light", {
    light2d: { kind: "ambient", color: [0.55, 0.62, 0.9, 1], intensity: 0.85 },
  });
  scene.add("Sun", {
    transform: { ...at(0, 0, 0), rotation: rotateZ(32) },
    light2d: {
      kind: "sun",
      color: [1, 0.9, 0.72, 1],
      intensity: 0.55,
      height: 0.9,
    },
  });
  const map = (name: string, layer: number, cells: number[], extra = {}) =>
    scene.add(name, {
      transform: at(0, 0, 0),
      tilemap: {
        tileset: "tiles.atlas.json",
        width,
        height,
        layer,
        cells,
        ...extra,
      },
    });
  map("Background", -10, layers.back.cells, { lit: true });
  const groundId = map("Ground", 0, layers.solid.cells, { occluder: true });
  scene.entities[groundId - 1].components.terrain = { kill_below: -5 };
  map("Foreground", 5, layers.front.cells, { lit: false });
  const heroId = scene.add("Hero", {
    transform: at(hero[0], hero[1], 0),
    sprite: {
      atlas: "sprites.atlas.json",
      anim: 1,
      pivot: [0.5, 0.4],
      layer: 2,
    },
    hero: {},
  });
  scene.add("Lantern", {
    transform: at(0, 0.3, 0),
    light2d: {
      kind: "lamp",
      color: [1, 0.82, 0.55, 1],
      intensity: 1.1,
      radius: 7,
      height: 1.4,
      shadows: true,
    },
  }, heroId);
  const camera = scene.add("Camera", {
    transform: at(10, 7, 10),
    camera: { orthographic: true, size: 11.25, near: 0.1, far: 100 },
    follow: {
      target: heroId,
      min: [10, 5.6],
      max: [width - 10, Math.max(5.6, height - 5.6)],
    },
  });
  const text = (
    name: string,
    slot: string,
    message: string,
    x: number,
    y: number,
    size: number,
    align: string,
    extra: Record<string, unknown> = {},
  ) =>
    scene.add(name, {
      transform: at(x, y, -5),
      text: { message, size, align, outline: 0.5, ...extra },
      hud: { slot },
    }, camera);
  text("Coins", "coins", "coins_hud", -9.5, 4.8, 1, "left");
  text("Time", "time", "time_hud", 9.5, 4.8, 1, "right");
  text("Hint", "hint", "hint", 0, -5, 0.5, "center");
  text("Banner", "banner", "clear", 0, 1, 2, "center", {
    color: [1, 0.9, 0.35, 0],
  });
  text("Detail", "detail", "clear_detail", 0, -0.8, 1, "center", {
    color: [1, 1, 1, 0],
  });
  return scene;
}

const torch = (scene: Scene, x: number, y: number) => {
  const id = scene.add("Torch", {
    transform: at(x, y, 0),
    sprite: {
      atlas: "sprites.atlas.json",
      anim: 8,
      layer: 1,
      pivot: [0.5, 0.5],
    },
  });
  scene.add("Torch light", {
    transform: at(0, 0.6, 0),
    light2d: {
      kind: "lamp",
      color: [1, 0.6, 0.25, 1],
      intensity: 1.2,
      radius: 8,
      falloff: 1.6,
      height: 1.1,
      shadows: true,
    },
    flicker: { base: 1.15, amount: 0.18, speed: 9 },
  }, id);
};

async function write(name: string, scene: Scene) {
  await Deno.writeTextFile(
    new URL(`../scenes/${name}.scene.json`, import.meta.url),
    stableJson({
      ink: 1,
      seed: 7,
      entities: scene.entities,
      resources: { game: {} },
    }),
  );
  console.log(
    `wrote scenes/${name}.scene.json: ${scene.entities.length} entities`,
  );
}

// The starter level ------------------------------------------------------------------

{
  const W = 64, H = 20;
  const back = new Layer(W, H),
    solid = new Layer(W, H),
    front = new Layer(W, H);
  // Ground: the start, a spiked pit, the middle, a plateau with a ladder up to
  // it, and the last stretch.
  const GROUND = tile("ground_15");
  for (const [a, b] of [[0, 12], [16, 33], [48, 63]]) {
    solid.fill(a, 0, b, 3, GROUND);
  }
  solid.fill(34, 0, 47, 8, GROUND);
  solid.fill(13, 0, 15, 0, tile("spikes"));
  // Stairs of crates and stone, floating planks, a brick pair.
  for (const [x, y] of [[29, 4], [30, 4], [30, 5]]) {
    solid.set(x, y, tile("crate"));
  }
  solid.fill(31, 4, 31, 6, tile("stone"));
  solid.fill(19, 5, 22, 5, tile("platform"));
  solid.fill(24, 7, 27, 7, tile("platform"));
  solid.fill(8, 5, 11, 5, tile("platform"));
  solid.fill(51, 5, 52, 5, tile("platform"));
  solid.fill(54, 7, 56, 7, tile("platform"));
  solid.fill(58, 4, 59, 5, tile("brick"));
  solid.fill(40, 9, 41, 9, tile("spikes"));
  // The ladder to the plateau.
  solid.fill(33, 4, 33, 9, tile("ladder"));
  solid.fill(48, 4, 49, 4, GROUND);

  // Re-pick the ground variants so rims and grass follow the shapes.
  const joined = new Set([...ground.connects, ...ground.tiles]);
  const original = [...solid.cells];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!joined.has(original[y * W + x])) continue;
      solid.cells[y * W + x] = ground.tiles[
        autotileMask(original, W, H, x, y, joined)
      ];
    }
  }
  // Scenery: clouds and bushes behind, flowers in front.
  for (const [x, y, w] of [[4, 14, 3], [18, 16, 4], [38, 15, 3], [52, 13, 4]]) {
    back.set(x, y, tile("cloud_left"));
    for (let i = 1; i < w - 1; i++) back.set(x + i, y, tile("cloud_mid"));
    back.set(x + w - 1, y, tile("cloud_right"));
  }
  for (const [x, y] of [[3, 4], [10, 4], [20, 4], [44, 9], [51, 4], [61, 4]]) {
    back.set(x, y, tile("bush"));
  }
  for (const x of [5, 6, 18, 23, 36, 38, 45, 50, 53]) {
    front.set(x, x > 33 && x < 48 ? 9 : 4, tile("flowers"));
  }

  const scene = scaffold(W, H, { back, solid, front }, [2.5, 4.4]);
  for (
    const [x, y] of [
      [5.5, 4.5],
      [9.5, 6.5],
      [10.5, 6.5],
      [20.5, 6.5],
      [21.5, 6.5],
      [25.5, 8.5],
      [26.5, 8.5],
      [37.5, 9.5],
      [38.5, 9.5],
      [43.5, 10.5],
      [44.5, 10.5],
      [51.5, 6.5],
      [55.5, 8.5],
      [53.5, 4.5],
    ]
  ) {
    scene.add("Coin", {
      transform: at(x, y, 0),
      sprite: {
        atlas: "sprites.atlas.json",
        anim: 5,
        layer: 1,
        pivot: [0.5, 0.5],
      },
      coin: {},
    });
  }
  for (
    const [x, y, dir] of [[22.5, 4.3, -1], [44.5, 9.3, 1], [50.5, 4.3, -1]]
  ) {
    scene.add("Slime", {
      transform: at(x, y, 0),
      sprite: {
        atlas: "sprites.atlas.json",
        anim: 6,
        layer: 1,
        pivot: [0.5, 0.2],
      },
      slime: { direction: dir },
    });
  }
  scene.add("Flag", {
    transform: at(61.5, 4.5, 0),
    sprite: {
      atlas: "sprites.atlas.json",
      anim: 7,
      layer: 1,
      pivot: [0.5, 0.5],
    },
    goal: {},
  });
  for (const [x, y] of [[8.5, 4.5], [26.5, 4.5], [46.5, 9.5], [52.5, 4.5]]) {
    torch(scene, x, y);
  }
  await write("main", scene);
}

// A blank map to build a level on ----------------------------------------------------

{
  const W = 40, H = 16;
  const scene = scaffold(
    W,
    H,
    { back: new Layer(W, H), solid: new Layer(W, H), front: new Layer(W, H) },
    [2.5, 4.4],
  );
  await write("blank", scene);
}
