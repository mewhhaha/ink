import type {
  Simple3dMaterial,
  Simple3dObject,
  Simple3dScene,
} from "@ink/rendering/simple3d.ts";

const limestone: Simple3dMaterial = {
  albedo: [0.46, 0.39, 0.3],
  emissive: [0, 0, 0],
  metallic: 0,
  roughness: 0.86,
};
const dark_stone: Simple3dMaterial = {
  albedo: [0.12, 0.14, 0.17],
  emissive: [0, 0, 0],
  metallic: 0,
  roughness: 0.92,
};
const oak: Simple3dMaterial = {
  albedo: [0.2, 0.075, 0.025],
  emissive: [0, 0, 0],
  metallic: 0,
  roughness: 0.72,
};
const brass: Simple3dMaterial = {
  albedo: [0.74, 0.42, 0.09],
  emissive: [0, 0, 0],
  metallic: 1,
  roughness: 0.18,
};

export function lighting_scene(elapsed_seconds: number): Simple3dScene {
  const camera_sway = Math.sin(elapsed_seconds * 0.1) * 1.4;
  return {
    camera: {
      position: [camera_sway, 6.8, 18],
      target: [0, 2.5, -4.5],
      vertical_fov_radians: 0.82,
    },
    clear_color: [0.006, 0.01, 0.022],
    ambient_color: [0.055, 0.065, 0.095],
    directional_light: {
      color: [1, 0.78, 0.54],
      direction: [-0.52, -1, -0.3],
      intensity: 1.35,
    },
    point_lights: [
      {
        color: [1, 0.3, 0.055],
        position: [-4, 2.5, -6],
        intensity: 7,
        range: 8,
      },
      {
        color: [1, 0.3, 0.055],
        position: [4, 2.5, -6],
        intensity: 7,
        range: 8,
      },
      {
        color: [0.08, 0.32, 1],
        position: [-7.5, 3.5, 1],
        intensity: 6,
        range: 9,
      },
      {
        color: [0.75, 0.12, 1],
        position: [7.5, 3.5, 1],
        intensity: 6,
        range: 9,
      },
    ],
    spot_lights: [
      {
        color: [1, 0.72, 0.42],
        position: [-5.8, 8.5, -7],
        direction: [0.4, -1, 0.55],
        intensity: 10,
        range: 18,
        outer_angle_radians: 0.48,
      },
      {
        color: [0.32, 0.52, 1],
        position: [5.8, 8.5, -7],
        direction: [-0.4, -1, 0.55],
        intensity: 9,
        range: 18,
        outer_angle_radians: 0.48,
      },
    ],
    fog_color: [0.025, 0.04, 0.075],
    fog_density: 0.011,
    exposure: -0.65,
    bloom_intensity: 0.24,
    objects: [
      {
        id: "courtyard",
        shape: "plane",
        position: [0, 0, 0],
        rotation_y_radians: 0,
        scale: [36, 1, 36],
        material: dark_stone,
      },
      ...castle_gate(),
      ...street_buildings(),
      ...courtyard_details(elapsed_seconds),
    ],
  };
}

function castle_gate(): readonly Simple3dObject[] {
  const objects: Simple3dObject[] = [
    castle_block("left-tower", [-6, 3.5, -9], [3.6, 7, 3.6]),
    castle_block("right-tower", [6, 3.5, -9], [3.6, 7, 3.6]),
    castle_block("left-wall", [-3.4, 3, -9], [1.8, 6, 1.2]),
    castle_block("right-wall", [3.4, 3, -9], [1.8, 6, 1.2]),
    castle_block("gate-lintel", [0, 5.15, -9], [5, 1.7, 1.2]),
    {
      id: "gate-shadow",
      shape: "cube",
      position: [0, 2.05, -9.55],
      rotation_y_radians: 0,
      scale: [4.8, 4.1, 0.25],
      material: {
        albedo: [0.012, 0.016, 0.025],
        emissive: [0, 0, 0],
        metallic: 0,
        roughness: 1,
      },
    },
    {
      id: "left-gate-door",
      shape: "cube",
      position: [-1.25, 1.85, -8.75],
      rotation_y_radians: -0.42,
      scale: [2.35, 3.7, 0.22],
      material: oak,
    },
    {
      id: "right-gate-door",
      shape: "cube",
      position: [1.25, 1.85, -8.75],
      rotation_y_radians: 0.42,
      scale: [2.35, 3.7, 0.22],
      material: oak,
    },
  ];
  const battlement_x = [-7.35, -5.45, -3.7, -1.85, 0, 1.85, 3.7, 5.45, 7.35];
  for (const [index, x] of battlement_x.entries()) {
    objects.push(
      castle_block(`battlement-${index}`, [x, x === 0 ? 6.35 : 7.45, -9], [
        0.85,
        1.1,
        1.65,
      ]),
    );
  }
  return objects;
}

function castle_block(
  id: string,
  position: readonly [number, number, number],
  scale: readonly [number, number, number],
): Simple3dObject {
  return {
    id,
    shape: "cube",
    position,
    rotation_y_radians: 0,
    scale,
    material: limestone,
  };
}

function street_buildings(): readonly Simple3dObject[] {
  const objects: Simple3dObject[] = [];
  for (const side of [-1, 1] as const) {
    const x = side * 9.5;
    objects.push(
      {
        id: `${side}-house-near`,
        shape: "cube",
        position: [x, 2.6, 2.5],
        rotation_y_radians: side * 0.04,
        scale: [5.2, 5.2, 5.2],
        material: {
          albedo: side < 0 ? [0.27, 0.11, 0.07] : [0.12, 0.19, 0.24],
          emissive: [0, 0, 0],
          metallic: 0,
          roughness: 0.8,
        },
      },
      {
        id: `${side}-house-far`,
        shape: "cube",
        position: [x * 0.92, 2.15, -3.2],
        rotation_y_radians: -side * 0.06,
        scale: [4.6, 4.3, 5.5],
        material: {
          albedo: side < 0 ? [0.12, 0.17, 0.21] : [0.3, 0.13, 0.065],
          emissive: [0, 0, 0],
          metallic: 0,
          roughness: 0.85,
        },
      },
    );
    for (const [window_index, z] of [3.8, 1.2, -2.2, -4.2].entries()) {
      objects.push({
        id: `${side}-window-${window_index}`,
        shape: "cube",
        position: [side * 6.86, 3.1, z],
        rotation_y_radians: 0,
        scale: [0.12, 1.15, 0.75],
        material: {
          albedo: [0.35, 0.17, 0.04],
          emissive: [2.8, 0.7, 0.08],
          metallic: 0,
          roughness: 0.25,
        },
      });
    }
  }
  return objects;
}

function courtyard_details(elapsed_seconds: number): readonly Simple3dObject[] {
  const objects: Simple3dObject[] = [
    castle_block("fountain-base", [0, 0.35, 1], [3.8, 0.7, 3.8]),
    castle_block("fountain-plinth", [0, 0.85, 1], [1.4, 1, 1.4]),
    {
      id: "fountain-statue",
      shape: "sphere",
      position: [0, 2, 1],
      rotation_y_radians: 0,
      scale: [1.35, 1.8, 1.35],
      material: brass,
    },
    {
      id: "fountain-light",
      shape: "sphere",
      position: [0, 3.25 + Math.sin(elapsed_seconds * 1.4) * 0.08, 1],
      rotation_y_radians: 0,
      scale: [0.22, 0.22, 0.22],
      material: {
        albedo: [0.1, 0.22, 0.4],
        emissive: [0.1, 1.8, 7],
        metallic: 0,
        roughness: 0.1,
      },
    },
  ];
  for (let index = 0; index < 8; index += 1) {
    const side = index % 2 === 0 ? -1 : 1;
    const row = Math.floor(index / 2);
    objects.push({
      id: `paving-${index}`,
      shape: "cube",
      position: [side * 1.55, 0.05, 5.3 - row * 3.1],
      rotation_y_radians: side * (0.035 + row * 0.018),
      scale: [2.8, 0.1, 2.65],
      material: {
        albedo: [0.22 + row * 0.025, 0.225 + row * 0.02, 0.24 + row * 0.015],
        emissive: [0, 0, 0],
        metallic: 0,
        roughness: 0.76,
      },
    });
  }
  for (const [index, x] of [-4, 4].entries()) {
    objects.push(
      {
        id: `lamp-post-${index}`,
        shape: "cube",
        position: [x, 1.25, -6],
        rotation_y_radians: 0,
        scale: [0.16, 2.5, 0.16],
        material: brass,
      },
      {
        id: `lamp-${index}`,
        shape: "sphere",
        position: [x, 2.55, -6],
        rotation_y_radians: 0,
        scale: [0.34, 0.34, 0.34],
        material: {
          albedo: [0.45, 0.12, 0.02],
          emissive: [5, 0.72, 0.08],
          metallic: 0,
          roughness: 0.12,
        },
      },
    );
  }
  return objects;
}
