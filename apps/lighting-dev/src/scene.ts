import type {
  Simple3dMaterial,
  Simple3dObject,
  Simple3dScene,
} from "@ink/rendering/simple3d.ts";

const matte_white: Simple3dMaterial = {
  albedo: [0.72, 0.74, 0.78],
  emissive: [0, 0, 0],
  metallic: 0,
  roughness: 0.82,
};

export function lighting_scene(elapsed_seconds: number): Simple3dScene {
  const orbit = elapsed_seconds * 0.18;
  const objects: Simple3dObject[] = [
    {
      id: "ground",
      shape: "plane",
      position: [0, 0, 0],
      rotation_y_radians: 0,
      scale: [30, 1, 30],
      material: matte_white,
    },
    {
      id: "backdrop",
      shape: "cube",
      position: [0, 4, -7],
      rotation_y_radians: 0,
      scale: [18, 8, 0.25],
      material: {
        albedo: [0.09, 0.11, 0.16],
        emissive: [0, 0, 0],
        metallic: 0,
        roughness: 0.95,
      },
    },
    ...material_spheres(),
    ...shadow_columns(),
    ...emissive_markers(elapsed_seconds),
  ];

  return {
    camera: {
      position: [Math.sin(orbit) * 13, 7.5, Math.cos(orbit) * 13],
      target: [0, 2.2, 0],
      vertical_fov_radians: Math.PI / 3,
    },
    clear_color: [0.008, 0.012, 0.025],
    ambient_color: [0.025, 0.035, 0.065],
    directional_light: {
      color: [1, 0.86, 0.68],
      direction: [-0.45, -1, -0.28],
      intensity: 2.4,
    },
    point_lights: [
      {
        color: [1, 0.08, 0.03],
        position: [-5, 1.8, 2],
        intensity: 18,
        range: 8,
      },
      { color: [0.03, 0.3, 1], position: [5, 2.2, 1], intensity: 20, range: 9 },
      {
        color: [0.15, 1, 0.34],
        position: [-2, 1.2, -3],
        intensity: 12,
        range: 6,
      },
      {
        color: [0.9, 0.18, 1],
        position: [2.5, 1.4, -3],
        intensity: 13,
        range: 6,
      },
    ],
    spot_lights: [
      {
        color: [1, 0.74, 0.44],
        position: [-4, 7, 5],
        direction: [0.45, -1, -0.55],
        intensity: 26,
        range: 16,
        outer_angle_radians: 0.55,
      },
      {
        color: [0.3, 0.55, 1],
        position: [4, 6, 4],
        direction: [-0.45, -1, -0.45],
        intensity: 22,
        range: 15,
        outer_angle_radians: 0.48,
      },
    ],
    fog_color: [0.018, 0.026, 0.052],
    fog_density: 0.018,
    exposure: -0.2,
    bloom_intensity: 0.32,
    objects,
  };
}

function material_spheres(): readonly Simple3dObject[] {
  const objects: Simple3dObject[] = [];
  for (let row = 0; row < 2; row += 1) {
    for (let column = 0; column < 6; column += 1) {
      objects.push({
        id: `material-${row}-${column}`,
        shape: "sphere",
        position: [(column - 2.5) * 1.65, 1.1 + row * 2.1, -0.4],
        rotation_y_radians: 0,
        scale: [1.35, 1.35, 1.35],
        material: {
          albedo: row === 0 ? [0.72, 0.12, 0.055] : [0.68, 0.72, 0.78],
          emissive: [0, 0, 0],
          metallic: row,
          roughness: 0.06 + column * 0.18,
        },
      });
    }
  }
  return objects;
}

function shadow_columns(): readonly Simple3dObject[] {
  return [-5.6, 5.6].map((x, index) => ({
    id: `shadow-column-${index}`,
    shape: "cube",
    position: [x, 2.3, -2.5],
    rotation_y_radians: 0.2 + index * 0.35,
    scale: [0.7, 4.6, 0.7],
    material: matte_white,
  }));
}

function emissive_markers(elapsed_seconds: number): readonly Simple3dObject[] {
  return [
    { id: "red", x: -5, color: [8, 0.04, 0.01] as const },
    { id: "blue", x: 5, color: [0.01, 0.25, 9] as const },
    { id: "green", x: -2, color: [0.04, 6, 0.18] as const },
    { id: "violet", x: 2.5, color: [5, 0.12, 7] as const },
  ].map(({ id, x, color }, index) => ({
    id: `emissive-${id}`,
    shape: "sphere",
    position: [
      x,
      1.2 + Math.sin(elapsed_seconds * 1.6 + index) * 0.15,
      index < 2 ? 2 : -3,
    ],
    rotation_y_radians: 0,
    scale: [0.22, 0.22, 0.22],
    material: {
      albedo: [0.04, 0.04, 0.04],
      emissive: color,
      metallic: 0,
      roughness: 0.2,
    },
  } satisfies Simple3dObject));
}
