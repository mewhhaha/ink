/** A procedural terrain and scatter layers for the renderer's tests, checks
 * and benchmarks: no assets on disk, deterministic. */
import {
  Heightfield,
  type Placement,
  ScatterSet,
  terrainNoise,
} from "@ink/geometry";
import { extractScene } from "./extract.ts";
import { catalog, fixtureWorld } from "./fixture.ts";
import type { Renderer, RenderScene, ScatterDraw, TerrainDraw } from "./mod.ts";
import { ScatterResource } from "./scatter_store.ts";
import { TerrainResource } from "./terrain_store.ts";

/** Rolling hills with a ridge, splat layers by height and slope. */
export function hills(
  cells: number,
  size: number,
  options: { layers?: number; height?: number } = {},
): Heightfield {
  const field = Heightfield.create(cells, { layers: options.layers ?? 4 });
  const stride = field.stride;
  const scale = options.height ?? 60;
  for (let z = 0; z < stride; z++) {
    for (let x = 0; x < stride; x++) {
      const px = (x / cells - 0.5) * size, pz = (z / cells - 0.5) * size;
      const big = terrainNoise(7, 4, px / 260, pz / 260);
      const ridge = 1 - Math.abs(terrainNoise(11, 3, px / 180, pz / 180));
      field.heights[z * stride + x] = scale *
        (0.55 * big + 0.45 * ridge * ridge);
    }
  }
  // Splat: layer 1 on steep ground, 2 on high ground, 3 in hollows, else 0.
  const n = field.splatCells;
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const fx = ((x + 0.5) / n) * cells, fz = ((z + 0.5) / n) * cells;
      const h = field.sampleCell(fx, fz);
      const dx = field.sampleCell(fx + 2, fz) - field.sampleCell(fx - 2, fz);
      const dz = field.sampleCell(fx, fz + 2) - field.sampleCell(fx, fz - 2);
      const slope = Math.hypot(dx, dz) / 4;
      const rock = Math.min(1, Math.max(0, (slope - 0.35) * 4));
      const high = Math.min(
        1,
        Math.max(0, (h - 0.55 * scale) / (0.15 * scale)),
      );
      const low = Math.min(1, Math.max(0, (0.12 * scale - h) / (0.1 * scale)));
      const w = [
        Math.max(0, 1 - rock - high - low),
        rock,
        high * (1 - rock),
        low * (1 - rock),
      ];
      const total = w.reduce((a, b) => a + b, 0) || 1;
      for (let c = 0; c < 4; c++) {
        field.splat[(z * n + x) * 4 + c] = Math.round(w[c] / total * 255);
      }
    }
  }
  return field;
}

/** Register four flat-coloured layer textures with simple noise. */
export function layerTextures(renderer: Renderer) {
  const colors = [
    [92, 128, 60],
    [128, 120, 112],
    [170, 150, 110],
    [196, 180, 140],
  ];
  const size = 64;
  colors.forEach((c, i) => {
    const albedo = new Uint8Array(size * size * 4);
    const normal = new Uint8Array(size * size * 4);
    const orm = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const v = terrainNoise(i + 3, 3, x / 8, y / 8);
        const k = (y * size + x) * 4;
        const shade = 0.8 + 0.3 * v;
        albedo.set([c[0] * shade, c[1] * shade, c[2] * shade, 255], k);
        const gx = terrainNoise(i + 3, 3, (x + 1) / 8, y / 8) - v;
        const gy = terrainNoise(i + 3, 3, x / 8, (y + 1) / 8) - v;
        normal.set([128 - gx * 600, 128 - gy * 600, 255, 128 + v * 100], k);
        orm.set([255, 190 - i * 20, 0, 255], k);
      }
    }
    renderer.assets.setTexture(`t/layer${i}.png`, {
      width: size,
      height: size,
      data: albedo,
    });
    renderer.assets.setTexture(`t/layer${i}_n.png`, {
      width: size,
      height: size,
      data: normal,
    });
    renderer.assets.setTexture(`t/layer${i}_orm.png`, {
      width: size,
      height: size,
      data: orm,
    });
  });
}

export function terrainDraw(
  size: number,
  overrides: Partial<TerrainDraw> = {},
): TerrainDraw {
  return {
    entity: 77,
    position: [0, 0, 0],
    heightmap: "terrain/hills.terrain",
    size,
    heightScale: 1,
    layers: [0, 1, 2, 3].map((i) => ({
      albedo: `t/layer${i}.png`,
      normal: `t/layer${i}_n.png`,
      orm: `t/layer${i}_orm.png`,
      tiling: [4, 6, 3, 4][i],
      color: [1, 1, 1, 1],
    })),
    blendHeight: 0.35,
    detail: { seed: 3, amplitude: 0.4, wavelength: 16, octaves: 3 },
    lodDistance: 96,
    castShadows: true,
    ...overrides,
  };
}

export function installTerrain(
  renderer: Renderer,
  field: Heightfield,
  path = "terrain/hills.terrain",
): TerrainResource {
  const resource = TerrainResource.ready(path, field);
  renderer.assets.setTerrain(path, resource);
  return resource;
}

/** `count` placements on a jittered grid, y follows the terrain. */
export function forest(
  count: number,
  size: number,
  seed = 1,
  height = 9,
): ScatterSet {
  const set = new ScatterSet(count);
  let s = seed >>> 0;
  const rand = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < count; i++) {
    const p: Placement = {
      x: (rand() - 0.5) * size,
      y: 0,
      z: (rand() - 0.5) * size,
      yaw: rand() * Math.PI * 2,
      scale: height * (0.7 + rand() * 0.8),
      tint: rand(),
    };
    set.add(p);
  }
  return set;
}

export function scatterDraw(overrides: Partial<ScatterDraw> = {}): ScatterDraw {
  return {
    entity: 88,
    position: [0, 0, 0],
    mesh: "builtin:cone",
    placements: "scatter/forest.scatter",
    color: [0.2, 0.5, 0.2, 1],
    roughness: 0.8,
    metallic: 0,
    tintVariation: 0.3,
    followTerrain: true,
    alignToGround: 0,
    maxDistance: 400,
    lodBias: 1,
    castShadows: true,
    alphaMode: "opaque",
    alphaCutoff: 0.5,
    doubleSided: false,
    ...overrides,
  };
}

export function installScatter(
  renderer: Renderer,
  set: ScatterSet,
  path = "scatter/forest.scatter",
): ScatterResource {
  const resource = ScatterResource.ready(path, set);
  renderer.assets.setScatter(path, resource);
  return resource;
}

/** The fixture scene with its meshes removed and the given large-world
 * content (sun, sky and fog stay). */
export function worldScene(
  terrains: TerrainDraw[],
  scatters: ScatterDraw[] = [],
): RenderScene {
  const scene = extractScene(fixtureWorld(), catalog);
  return {
    ...scene,
    draws: [],
    brushes: [],
    terrains,
    scatters,
    bounds: null,
  };
}
