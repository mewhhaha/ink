/**
 * Writes scenes/main.scene.json: the terrain, four scatter layers, sun, sky, a
 * camera high above the start and a placeholder player in the meadow. Entities
 * stay few: the 100,000 instances live in the `.scatter` files.
 *
 *   deno run -A examples/terrain/scripts/scene.ts
 */
import {
  collisionGrid,
  Heightfield,
  quat,
  terrainHeightAt,
} from "@ink/geometry";
import type { SceneFile } from "@ink/schema";
import { stableJson } from "../../../packages/dev/paths.ts";
import { TERRAIN_URL } from "./terrain.ts";
import { SCATTER_FILES } from "./scatter.ts";
import {
  findSpawn,
  LAYERS,
  terrainParamsFor,
  TILING,
  WATER_LEVEL,
} from "./world.ts";

export const SCENE_URL = new URL("../scenes/main.scene.json", import.meta.url);

/** Asset paths the scene names, relative to assets/. */
export const ASSETS = {
  terrain: "terrain/world.terrain",
  layers: LAYERS.map((name) => ({
    albedo: `terrain/${name}.png`,
    normal: `terrain/${name}_n.png`,
    orm: `terrain/${name}_orm.png`,
  })),
  meshes: {
    pines: "scatter/pine.glb",
    oaks: "scatter/oak.glb",
    rocks: "scatter/rock.glb",
    grass: "scatter/grass.glb",
  },
  placements: {
    pines: `scatter/${SCATTER_FILES.pines}`,
    oaks: `scatter/${SCATTER_FILES.oaks}`,
    rocks: `scatter/${SCATTER_FILES.rocks}`,
    grass: `scatter/${SCATTER_FILES.grass}`,
  },
};

/** Every asset path the scene refers to. */
export const assetPaths = (): string[] => [
  ASSETS.terrain,
  ...ASSETS.layers.flatMap((l) => [l.albedo, l.normal, l.orm]),
  ...Object.values(ASSETS.meshes),
  ...Object.values(ASSETS.placements),
];

/** Collision grid cells per side (the terrain component's `collision_cells`). */
export const COLLISION_CELLS = 128;

const round = (v: number, digits = 3) => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};

type Components = Record<string, unknown>;

/** The scene for a generated field. Deterministic. */
export function buildScene(field: Heightfield): SceneFile {
  const params = terrainParamsFor();
  const entities: SceneFile["entities"] = [];
  const add = (name: string, components: Components, parent?: number) => {
    const id = entities.length + 1;
    entities.push({ id, name, ...(parent ? { parent } : {}), components });
    return id;
  };
  const at = (
    position: number[],
    rotation: number[] = [0, 0, 0, 1],
    scale: number[] = [1, 1, 1],
  ) => ({ position, rotation, scale });

  const [sx, sz] = findSpawn(field, params);
  const ground = terrainHeightAt(field, params, sx, sz);

  add("Environment", {
    environment: {
      sky: "procedural",
      sky_altitude: 100,
      cloud_coverage: 0.35,
      cloud_height: 2200,
      cloud_scale: 1400,
      ambient: 1,
      ambient_occlusion: 1,
      ao_radius: 0.8,
      shadow_distance: 400,
      exposure: 0.2,
      tonemap: "agx",
      bloom: 0.06,
      vignette: 0.15,
      // Exponential height fog: about 30% haze at one kilometre, 55% at two,
      // thinning with height so the peaks stand clear.
      fog_density: 0.0004,
      fog_height: 0,
      fog_falloff: 0.004,
    },
  });
  // The sun stands in the south-west, behind a camera that looks north.
  add("Sun", {
    transform: at(
      [0, 400, 0],
      quat.lookRotation([0.5, -0.62, -0.6]).map((v) => round(v, 6)),
    ),
    light: {
      kind: "directional",
      color: [1, 0.96, 0.9, 1],
      intensity: 1.8,
      shadows: true,
      softness: 1.5,
    },
  });

  add("Terrain", {
    transform: at([0, 0, 0]),
    terrain: {
      heightmap: ASSETS.terrain,
      size: params.size,
      height_scale: 1,
      layers: ASSETS.layers.map((layer, i) => ({
        ...layer,
        tiling: TILING[i],
        color: [1, 1, 1, 1],
      })),
      blend_height: 0.35,
      detail_amplitude: params.detail.amplitude,
      detail_wavelength: params.detail.wavelength,
      detail_octaves: params.detail.octaves,
      detail_seed: params.detail.seed,
      lod_distance: 96,
      cast_shadows: true,
      collision_cells: COLLISION_CELLS,
      grid: Array.from(
        collisionGrid(field, params, COLLISION_CELLS),
        (v) => round(v),
      ),
      revision: field.revision,
    },
  });

  const layer = (
    name: string,
    kind: keyof typeof ASSETS.meshes,
    options: Components,
  ) =>
    add(name, {
      transform: at([0, 0, 0]),
      scatter: {
        shape: ASSETS.meshes[kind],
        placements: ASSETS.placements[kind],
        color: [1, 1, 1, 1],
        roughness: 0.9,
        metallic: 0,
        follow_terrain: true,
        lod_bias: 1,
        ...options,
      },
    });
  layer("Pines", "pines", {
    tint_variation: 0.25,
    max_distance: 700,
    cast_shadows: true,
  });
  layer("Oaks", "oaks", {
    tint_variation: 0.25,
    max_distance: 700,
    cast_shadows: true,
  });
  layer("Rocks", "rocks", {
    tint_variation: 0.3,
    align_to_ground: 0.6,
    max_distance: 500,
    cast_shadows: true,
  });
  layer("Grass", "grass", {
    tint_variation: 0.35,
    align_to_ground: 0.5,
    max_distance: 120,
    cast_shadows: false,
    double_sided: true,
  });

  // Lakes and the river are the ground under this level.
  add("Water", {
    transform: at([0, WATER_LEVEL, 0], [0, 0, 0, 1], [
      params.size,
      1,
      params.size,
    ]),
    mesh: {
      shape: "builtin:plane",
      color: [0.07, 0.2, 0.28, 0.8],
      roughness: 0.05,
      metallic: 0,
      alpha_mode: "blend",
      cast_shadows: false,
    },
  });

  add("Player", {
    transform: at([round(sx), round(ground + 0.9), round(sz)], [0, 0, 0, 1], [
      1.6,
      1.8,
      1.6,
    ]),
    mesh: {
      shape: "builtin:capsule",
      color: [0.36, 0.55, 0.95, 1],
      roughness: 0.4,
    },
    walker: {},
  });

  // High above the start, looking north-west across the valley to the peaks.
  const eye = [sx + 120, ground + 230, sz + 380];
  const target = [sx, ground, sz - 120];
  add("Camera", {
    transform: at(
      eye.map((v) => round(v)),
      quat.lookRotation([
        target[0] - eye[0],
        target[1] - eye[1],
        target[2] - eye[2],
      ]).map((v) => round(v, 6)),
    ),
    camera: { fov: 60, near: 0.5, far: 6000, active: true },
  });

  return { ink: 1, seed: 4242, nextEntity: entities.length + 1, entities };
}

/**
 * The scene as text, formatted the way `deno fmt` leaves JSON: the collision
 * grid has one value per line (stableJson would wrap it like prose and fail
 * `deno fmt --check`).
 */
export function sceneText(scene: SceneFile): string {
  const marker = "@@collision-grid@@";
  let grid: number[] = [];
  const entities = scene.entities.map((entity) => {
    const terrain = entity.components.terrain as
      | { grid: number[] }
      | undefined;
    if (!terrain) return entity;
    grid = terrain.grid;
    return {
      ...entity,
      components: {
        ...entity.components,
        terrain: { ...terrain, grid: marker },
      },
    };
  });
  return stableJson({ ...scene, entities }).replace(
    new RegExp(`^( *)("grid": )"${marker}"`, "m"),
    (_, indent: string, key: string) =>
      `${indent}${key}[\n${
        grid.map((v) => `${indent}  ${v}`).join(",\n")
      }\n${indent}]`,
  );
}

export async function writeScene() {
  const field = Heightfield.parse(await Deno.readFile(TERRAIN_URL));
  const scene = buildScene(field);
  await Deno.mkdir(new URL(".", SCENE_URL), { recursive: true });
  const text = sceneText(scene);
  await Deno.writeTextFile(SCENE_URL, text);
  console.log(
    `scene: ${scene.entities.length} entities, ${
      (text.length / 1e3).toFixed(0)
    } kB`,
  );
}

if (import.meta.main) await writeScene();
