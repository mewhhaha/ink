/** A small world used by the renderer's tests and by the screenshot harness. */
import { boxBrush, clipBrush, quat, type Vec3 } from "@ink/geometry";
import {
  type Catalog,
  defineSchema,
  type SceneEntity,
  sceneToWorld,
  standard,
  type WorldModel,
} from "@ink/schema";

export const schema = defineSchema({ components: { ...standard.components } });

export const catalog: Catalog = {
  assets: {
    mesh: [...standard.builtinMeshes],
    texture: ["textures/checker.png", "textures/missing.png"],
  },
};

const mesh = (
  id: number,
  shape: string,
  position: Vec3,
  extra: Record<string, unknown> = {},
  transform: Record<string, unknown> = {},
  mat: Record<string, unknown> = {},
): SceneEntity => ({
  id,
  name: shape,
  components: {
    transform: { position, ...transform },
    mesh: { shape, ...mat, ...extra },
  },
});

export function fixtureWorld(): WorldModel {
  const entities: SceneEntity[] = [
    mesh(1, "builtin:plane", [0, 0, 0], {
      color: [0.62, 0.64, 0.68, 1],
      roughness: 0.9,
    }, { scale: [24, 1, 24] }),
    mesh(2, "builtin:cube", [-2.2, 0.5, 0.4], { color: [0.86, 0.25, 0.22, 1] }),
    mesh(3, "builtin:sphere", [0, 0.5, 1.4], {
      color: [0.95, 0.75, 0.3, 1],
      metallic: 1,
      roughness: 0.25,
    }),
    mesh(4, "builtin:cylinder", [2.0, 0.5, 0.2], {
      color: [0.3, 0.7, 0.45, 1],
    }),
    mesh(5, "builtin:capsule", [-0.6, 0.5, -1.6], {
      color: [0.35, 0.5, 0.9, 1],
      roughness: 0.35,
    }),
    mesh(6, "builtin:cone", [1.6, 0.5, -1.6], { color: [0.8, 0.45, 0.85, 1] }),
    mesh(7, "builtin:cube", [-3.4, 0.5, -2.2], {
      color: [1, 1, 1, 1],
      texture: "textures/checker.png",
    }, { rotation: quat.fromEuler([0, 30, 0]) }),
    mesh(8, "builtin:sphere", [3.6, 0.5, -2.0], {
      color: [1, 1, 1, 1],
      texture: "textures/missing.png",
    }),
    {
      id: 9,
      name: "sun",
      components: {
        transform: {
          position: [0, 8, 0],
          rotation: quat.fromEuler([-50, 35, 0]),
        },
        light: {
          kind: "directional",
          intensity: 1.5,
          shadows: true,
          color: [1, 0.96, 0.9, 1],
        },
      },
    },
    {
      id: 10,
      name: "lamp",
      components: {
        transform: { position: [0.8, 1.6, 2.6] },
        light: {
          kind: "point",
          intensity: 6,
          range: 9,
          color: [1, 0.7, 0.4, 1],
        },
      },
    },
    {
      id: 11,
      name: "camera",
      components: {
        transform: {
          position: [0, 3, 9],
          rotation: quat.fromEuler([-14, 0, 0]),
        },
        camera: { fov: 55 },
      },
    },
  ];
  // A brush room corner: a slab, a textured wall, and a wedge made by clipping.
  const slab = boxBrush([-3, -0.4, -6], [3, 0.05, -4.5]);
  const wall = boxBrush([-3, 0, -6], [-2.5, 2.6, -2]).map((f, i) => ({
    ...f,
    texture: i < 2 ? 1 : 0,
  }));
  const wedge = clipBrush(boxBrush([3.2, 0, -2.5], [5.2, 1.6, 0]), [
    0,
    0.7071,
    0.7071,
    0.424,
  ])
    .back!.map((f, i) => ({
      ...f,
      color: i % 2 ? [0.9, 0.7, 0.5, 1] : [0.7, 0.85, 1, 1],
    }));
  const brush = (id: number, name: string, faces: unknown[]): SceneEntity => ({
    id,
    name,
    components: { transform: { position: [0, 0, 0] }, brush: { faces } },
  });
  entities.push(
    brush(12, "slab", slab),
    brush(13, "wall", wall),
    brush(14, "wedge", wedge),
  );
  return sceneToWorld(schema, { ink: 1, entities }, catalog).world;
}

// A lighting lab: emissive objects, a normal-mapped surface built from the
// builtin noise textures, fog and an environment, for HDR and look checks.

export const labCatalog: Catalog = {
  assets: {
    mesh: [...standard.builtinMeshes],
    texture: [
      "builtin:checker",
      "builtin:noise/fbm",
      "builtin:noise/worley",
      "builtin:noise/ridged",
      "lab/fbm-normal.png",
      "lab/worley-orm.png",
    ],
  },
};

/** Tangent-space normal map (OpenGL, +Y up) from a height image's red channel;
 * wraps around, so tiling noise stays seamless. */
export function normalMapFromHeight(
  height: { width: number; height: number; data: Uint8Array },
  strength = 4,
): { width: number; height: number; data: Uint8Array } {
  const { width, height: h } = height;
  const at = (x: number, y: number) =>
    height.data[(((y + h) % h) * width + ((x + width) % width)) * 4] / 255;
  const data = new Uint8Array(width * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      // Image rows run down; +Y (up) is towards smaller y.
      const dy = (at(x, y - 1) - at(x, y + 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      data.set([
        Math.round(((-dx / len) * 0.5 + 0.5) * 255),
        Math.round(((-dy / len) * 0.5 + 0.5) * 255),
        Math.round(((1 / len) * 0.5 + 0.5) * 255),
        255,
      ], (y * width + x) * 4);
    }
  }
  return { width, height: h, data };
}

/** Occlusion / roughness / metallic from the Worley noise: cells are
 * occluded in the cracks, rough in the cracks and polished on top. */
export function ormFromHeight(
  height: { width: number; height: number; data: Uint8Array },
): { width: number; height: number; data: Uint8Array } {
  const data = new Uint8Array(height.data.length);
  for (let i = 0; i < height.data.length; i += 4) {
    const v = height.data[i];
    data.set([
      Math.round(80 + (v / 255) * 175),
      Math.round(255 - v * 0.6),
      0,
      255,
    ], i);
  }
  return { width: height.width, height: height.height, data };
}

export function labWorld(
  environment: Record<string, unknown> = {},
): WorldModel {
  const entities: SceneEntity[] = [
    mesh(1, "builtin:plane", [0, 0, 0], {
      color: [0.7, 0.7, 0.72, 1],
      texture: "builtin:checker",
      roughness: 0.85,
      uv_scale: [12, 12],
    }, { scale: [40, 1, 40] }),
    // Normal-mapped sphere and wall (fbm bumps), tiled.
    mesh(2, "builtin:sphere", [-2.4, 1, 0], {
      color: [0.85, 0.85, 0.9, 1],
      texture: "builtin:noise/fbm",
      normal_map: "lab/fbm-normal.png",
      normal_strength: 1.5,
      uv_scale: [3, 2],
      roughness: 0.45,
    }, { scale: [2, 2, 2] }),
    mesh(3, "builtin:cube", [0.4, 1, -0.4], {
      color: [0.8, 0.75, 0.7, 1],
      texture: "builtin:noise/worley",
      normal_map: "lab/fbm-normal.png",
      orm_map: "lab/worley-orm.png",
      normal_strength: 2,
      uv_scale: [2, 2],
      roughness: 1,
      metallic: 1,
    }, { scale: [2, 2, 2], rotation: quat.fromEuler([0, 25, 0]) }),
    // Emissive: HDR strengths above 1 glow.
    mesh(4, "builtin:sphere", [2.6, 0.6, 0.6], {
      color: [0.1, 0.1, 0.1, 1],
      emissive: [1, 0.45, 0.1, 1],
      emissive_strength: 12,
    }, { scale: [1.2, 1.2, 1.2] }),
    mesh(5, "builtin:cube", [4.2, 0.5, -1.4], {
      color: [0.05, 0.05, 0.05, 1],
      emissive: [0.15, 0.8, 1, 1],
      emissive_strength: 40,
    }, { scale: [0.6, 1, 0.6] }),
    mesh(6, "builtin:cylinder", [1.8, 0.75, -3.4], {
      color: [0.9, 0.2, 0.2, 1],
      roughness: 0.3,
    }, { scale: [0.8, 1.5, 0.8] }),
    mesh(7, "builtin:sphere", [-0.4, 0.45, 2.2], {
      color: [0.95, 0.78, 0.35, 1],
      metallic: 1,
      roughness: 0.2,
    }, { scale: [0.9, 0.9, 0.9] }),
    {
      id: 20,
      name: "sun",
      components: {
        transform: {
          position: [0, 8, 0],
          rotation: quat.fromEuler([-38, 40, 0]),
        },
        light: {
          kind: "directional",
          intensity: 3.2,
          shadows: true,
          color: [1, 0.93, 0.82, 1],
        },
      },
    },
    {
      id: 21,
      name: "lamp",
      components: {
        transform: { position: [3.4, 1.4, 1.4] },
        light: {
          kind: "point",
          intensity: 14,
          range: 8,
          color: [1, 0.55, 0.25, 1],
        },
      },
    },
    {
      id: 22,
      name: "camera",
      components: {
        transform: {
          position: [0.5, 2.6, 8.6],
          rotation: quat.fromEuler([-11, 0, 0]),
        },
        camera: { fov: 52 },
      },
    },
    { id: 23, name: "environment", components: { environment } },
  ];
  return sceneToWorld(schema, { ink: 1, entities }, labCatalog).world;
}
