/** Scenes for shadow and ambient occlusion tests and screenshots: a game-like
 * indoor level built from brushes, and an outdoor scene with long shadows. */
import { boxBrush, quat, type Vec3 } from "@ink/geometry";
import {
  type Catalog,
  type SceneEntity,
  sceneToWorld,
  standard,
  type WorldModel,
} from "@ink/schema";
import { schema } from "./fixture.ts";

export const shadowCatalog: Catalog = {
  assets: {
    mesh: [...standard.builtinMeshes],
    texture: ["builtin:checker", "builtin:noise/fbm", "builtin:noise/worley"],
  },
};

type Extra = Record<string, unknown>;
const mesh = (
  id: number,
  shape: string,
  position: Vec3,
  extra: Extra = {},
  transform: Extra = {},
): SceneEntity => ({
  id,
  name: `${shape}-${id}`,
  components: {
    transform: { position, ...transform },
    mesh: { shape, ...extra },
  },
});

let nextBrush = 1000;
const box = (
  min: Vec3,
  max: Vec3,
  color: [number, number, number, number],
  texture = 0,
): SceneEntity => ({
  id: nextBrush++,
  name: "brush",
  components: {
    transform: { position: [0, 0, 0] },
    brush: {
      faces: boxBrush(min, max).map((f) => ({ ...f, color, texture })),
    },
  },
});

const light = (
  id: number,
  position: Vec3,
  euler: Vec3,
  extra: Extra,
): SceneEntity => ({
  id,
  name: `light-${id}`,
  components: {
    transform: { position, rotation: quat.fromEuler(euler) },
    light: extra,
  },
});

const build = (
  entities: SceneEntity[],
  environment: Extra,
): WorldModel => {
  entities.push({ id: 9000, name: "environment", components: { environment } });
  return sceneToWorld(schema, { ink: 1, entities }, shadowCatalog).world;
};

/** A hall with a corridor, pillars, crates, a point light, a spot light, a
 * corridor lamp and the sun through a window. */
export function indoorWorld(environment: Extra = {}): WorldModel {
  nextBrush = 1000;
  const stone: [number, number, number, number] = [0.72, 0.68, 0.62, 1];
  const floor: [number, number, number, number] = [0.7, 0.66, 0.6, 1];
  const e: SceneEntity[] = [
    // Floor, ceiling and walls of the hall (16 x 16, 5 high).
    box([-8.4, -0.5, -8.4], [8.4, 0, 8.4], floor, 1),
    box([-8.4, 5, -8.4], [8.4, 5.3, 8.4], stone),
    box([-8.4, 0, -8.4], [-8, 5, 8.4], stone),
    box([-8.4, 0, 8], [8.4, 5, 8.4], stone),
    // North wall with a window (x -1.5..1.5, y 1.5..3.5).
    box([-8.4, 0, -8.4], [-1.5, 5, -8], stone),
    box([1.5, 0, -8.4], [8.4, 5, -8], stone),
    box([-1.5, 0, -8.4], [1.5, 1.5, -8], stone),
    box([-1.5, 3.5, -8.4], [1.5, 5, -8], stone),
    // East wall with the corridor opening (z -1.5..1.5, y 0..3.5).
    box([8, 0, -8.4], [8.4, 5, -1.5], stone),
    box([8, 0, 1.5], [8.4, 5, 8.4], stone),
    box([8, 3.5, -1.5], [8.4, 5, 1.5], stone),
    // Corridor.
    box([8.4, -0.5, -1.8], [24, 0, 1.8], floor, 1),
    box([8.4, 0, -1.8], [24, 3.5, -1.5], stone),
    box([8.4, 0, 1.5], [24, 3.5, 1.8], stone),
    box([8.4, 3.5, -1.8], [24, 3.8, 1.8], stone),
    box([24, 0, -1.8], [24.3, 3.8, 1.8], stone),
    // A raised platform and steps.
    box([-8, 0, -8], [-4, 0.5, -3], stone),
    box([-4, 0, -8], [-3.5, 0.25, -3], stone),
  ];
  // Pillars.
  let id = 1;
  for (const x of [-4.5, 4.5]) {
    for (const z of [-3, 3.5]) {
      e.push(mesh(id++, "builtin:cylinder", [x, 2.5, z], {
        color: [0.85, 0.8, 0.72, 1],
        roughness: 0.8,
      }, { scale: [0.9, 5, 0.9] }));
    }
  }
  // Crates, a statue, a table.
  e.push(
    mesh(id++, "builtin:cube", [6.6, 0.5, 6.4], {
      color: [0.65, 0.42, 0.22, 1],
      roughness: 0.7,
    }),
    mesh(id++, "builtin:cube", [5.4, 0.35, 7.0], {
      color: [0.6, 0.38, 0.2, 1],
      roughness: 0.7,
    }, { scale: [0.7, 0.7, 0.7], rotation: quat.fromEuler([0, 25, 0]) }),
    mesh(id++, "builtin:cube", [6.5, 1.5, 6.5], {
      color: [0.7, 0.46, 0.25, 1],
    }, { scale: [0.8, 0.8, 0.8], rotation: quat.fromEuler([0, -15, 0]) }),
    mesh(id++, "builtin:sphere", [0.5, 1.05, 1.2], {
      color: [0.82, 0.8, 0.76, 1],
      roughness: 0.4,
    }, { scale: [1.1, 1.1, 1.1] }),
    mesh(id++, "builtin:cylinder", [0.5, 0.35, 1.2], {
      color: [0.5, 0.48, 0.45, 1],
    }, { scale: [1.4, 0.7, 1.4] }),
    mesh(id++, "builtin:cube", [3, 0.8, -4.5], {
      color: [0.4, 0.3, 0.25, 1],
    }, { scale: [2.2, 0.1, 1.1] }),
    mesh(id++, "builtin:cube", [2.2, 0.4, -4.9], {
      color: [0.4, 0.3, 0.25, 1],
    }, { scale: [0.12, 0.8, 0.12] }),
    mesh(id++, "builtin:cube", [3.8, 0.4, -4.1], {
      color: [0.4, 0.3, 0.25, 1],
    }, { scale: [0.12, 0.8, 0.12] }),
    mesh(id++, "builtin:sphere", [3.3, 1.0, -4.4], {
      color: [0.3, 0.55, 0.8, 1],
      roughness: 0.3,
    }, { scale: [0.3, 0.3, 0.3] }),
    // Lights.
    light(100, [-3, 3.4, -1], [0, 0, 0], {
      kind: "point",
      intensity: 14,
      range: 13,
      color: [1, 0.68, 0.38, 1],
      shadows: true,
    }),
    light(101, [5.5, 4.7, 5.5], [-55, 40, 0], {
      kind: "spot",
      intensity: 90,
      range: 16,
      angle: 62,
      color: [0.85, 0.92, 1, 1],
      shadows: true,
    }),
    light(102, [15, 3.1, 0], [0, 0, 0], {
      kind: "point",
      intensity: 9,
      range: 10,
      color: [0.7, 0.85, 1, 1],
      shadows: true,
    }),
    // The sun, low, from the north through the window.
    light(103, [0, 20, -30], [-24, 180, 0], {
      kind: "directional",
      intensity: 4,
      color: [1, 0.9, 0.72, 1],
      shadows: true,
    }),
  );
  return build(e, { ambient: 0.5, ...environment });
}

export const indoorView = {
  eye: [-7, 2.0, 7] as Vec3,
  target: [1.5, 1.3, -2.5] as Vec3,
  fov: 72,
};
export const corridorView = {
  eye: [10.5, 1.6, 0.4] as Vec3,
  target: [20, 1.4, -0.2] as Vec3,
  fov: 70,
};

/** Long shadows over distance: low sun, a tower, pillars receding, trees. */
export function outdoorWorld(
  environment: Extra = {},
  sun: Extra = {},
): WorldModel {
  const e: SceneEntity[] = [
    mesh(1, "builtin:plane", [0, 0, 0], {
      color: [0.42, 0.5, 0.3, 1],
      texture: "builtin:noise/fbm",
      roughness: 0.95,
      uv_scale: [60, 60],
    }, { scale: [600, 1, 600] }),
  ];
  let id = 10;
  // A row of pillars on each side, 4 m apart for 120 m.
  for (let i = 0; i < 30; i++) {
    for (const x of [-7, 7]) {
      e.push(mesh(id++, "builtin:cylinder", [x, 2, -i * 4], {
        color: [0.8, 0.77, 0.7, 1],
        roughness: 0.8,
      }, { scale: [0.8, 4, 0.8] }));
    }
  }
  // Trees: trunk and crown.
  const trees: [number, number, number][] = [
    [-13, 3, 1],
    [-18, -8, 1.3],
    [12, -14, 1.1],
    [16, -2, 1.4],
    [-10, -30, 1.2],
    [14, -50, 1.5],
    [-16, -70, 1.3],
    [20, -90, 1.2],
  ];
  for (const [x, z, s] of trees) {
    e.push(
      mesh(id++, "builtin:cylinder", [x, 1.5 * s, z], {
        color: [0.35, 0.25, 0.15, 1],
      }, { scale: [0.35 * s, 3 * s, 0.35 * s] }),
      mesh(id++, "builtin:sphere", [x, 4.2 * s, z], {
        color: [0.2, 0.42, 0.18, 1],
        roughness: 0.9,
      }, { scale: [3 * s, 3 * s, 3 * s] }),
    );
  }
  e.push(
    // Tower and a wall for long and wide shadows.
    mesh(id++, "builtin:cylinder", [-22, 14, -20], {
      color: [0.7, 0.68, 0.64, 1],
    }, { scale: [3, 28, 3] }),
    mesh(id++, "builtin:cube", [4, 1.5, -26], {
      color: [0.72, 0.7, 0.66, 1],
    }, { scale: [14, 3, 0.6] }),
    // Things in the foreground.
    mesh(id++, "builtin:cube", [-2.2, 0.5, 5], {
      color: [0.8, 0.3, 0.25, 1],
    }),
    mesh(id++, "builtin:sphere", [0, 0.6, 3.2], {
      color: [0.9, 0.78, 0.3, 1],
      roughness: 0.35,
    }, { scale: [1.2, 1.2, 1.2] }),
    mesh(id++, "builtin:cylinder", [2.4, 1, 4.2], {
      color: [0.3, 0.55, 0.85, 1],
    }, { scale: [0.7, 2, 0.7] }),
    light(500, [0, 30, 0], [-15, 75, 0], {
      kind: "directional",
      intensity: 4.4,
      color: [1, 0.86, 0.68, 1],
      shadows: true,
      ...sun,
    }),
    {
      id: 501,
      name: "camera",
      components: {
        transform: { position: [0, 1.7, 12] },
        camera: { fov: 60 },
      },
    },
  );
  return build(e, { shadow_distance: 120, ...environment });
}

export const outdoorView = {
  eye: [-3.5, 1.7, 11] as Vec3,
  target: [1, 1.8, -20] as Vec3,
  fov: 62,
};
