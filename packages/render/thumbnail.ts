/**
 * Asset thumbnails drawn with the renderer itself: an offscreen view, a key
 * light and a neutral gradient sky, a camera that frames the object. The
 * picture is a still (no temporal history, frozen grain), so the same asset
 * always gives the same pixels and can be cached by content hash.
 */
import { type Mat4, mat4, meshBounds, type Vec3 } from "@ink/geometry";
import { lookAtCamera } from "./camera.ts";
import { defaultEnvironment } from "./environment.ts";
import type { Draw, Environment, Renderer, RenderScene } from "./types.ts";

export interface ThumbnailSpec {
  /** Catalog path of a mesh (`models/rock.glb`, `builtin:cube`). */
  mesh: string;
  /** Show this glTF material (by index) on a sphere instead of the mesh. */
  material?: number;
}

const STUDIO: Partial<Environment> = {
  sky: "gradient",
  skyColor: [0.66, 0.7, 0.76, 1],
  horizonColor: [0.82, 0.83, 0.84, 1],
  groundColor: [0.4, 0.39, 0.38, 1],
  ambient: 1.3,
  ambientOcclusion: 0,
  bloom: 0,
  vignette: 0,
  grain: 0,
  fogDensity: 0,
  indirect: 0,
  reflections: 0,
  autoExposure: false,
  exposure: 0,
  tonemap: "neutral",
};

function baseDraw(mesh: string): Draw {
  return {
    entity: 1,
    mesh,
    matrix: mat4.identity(),
    color: [1, 1, 1, 1],
    roughness: 0.6,
    metallic: 0,
    emissive: [0, 0, 0, 1],
    emissiveStrength: 1,
    normalStrength: 1,
    uvScale: [1, 1],
    castShadows: false,
    useMaterials: true,
  };
}

/** Render a PNG thumbnail of `size` x `size` pixels. */
export async function renderThumbnail(
  renderer: Renderer,
  spec: ThumbnailSpec,
  size = 128,
): Promise<Blob> {
  const assets = renderer.assets;
  assets.preload("mesh", spec.mesh);
  await assets.settled();
  const data = assets.meshData(spec.mesh);
  if (!data) throw new Error(`mesh ${spec.mesh} did not load`);
  let draw: Draw;
  let center: Vec3, radius: number;
  if (spec.material !== undefined) {
    const material = assets.modelData(spec.mesh)?.materials[spec.material];
    if (!material) throw new Error(`no material ${spec.material}`);
    draw = {
      ...baseDraw("builtin:sphere"),
      material,
      texture: material.base?.uri,
      normalMap: material.normal?.uri,
      ormMap: material.metallicRoughness?.uri,
      color: material.color,
      roughness: material.roughness,
      metallic: material.metallic,
      emissive: material.emissive,
      emissiveStrength: material.emissiveStrength,
      normalStrength: material.normalStrength,
      alphaMode: material.alphaMode,
      alphaCutoff: material.alphaCutoff,
      doubleSided: material.doubleSided,
    };
    center = [0, 0, 0];
    radius = 0.5;
  } else {
    draw = baseDraw(spec.mesh);
    const box = meshBounds(data);
    center = [0, 1, 2].map((i) => (box.min[i] + box.max[i]) / 2) as Vec3;
    radius = Math.hypot(
          box.max[0] - box.min[0],
          box.max[1] - box.min[1],
          box.max[2] - box.min[2],
        ) / 2 || 0.5;
  }
  const matrices = new Map<number, Mat4>([[1, draw.matrix]]);
  const scene: RenderScene = {
    matrices,
    draws: [draw],
    brushes: [],
    cameras: [],
    environment: { ...defaultEnvironment(), ...STUDIO },
    bounds: null,
    lights: [{
      entity: 2,
      kind: "directional",
      color: [1, 0.97, 0.92],
      intensity: 3,
      range: 0,
      angle: 0,
      shadows: false,
      softness: 0,
      position: [0, 0, 0],
      direction: [-0.45, -0.65, -0.62],
    }],
  };
  const fov = 32;
  const distance = radius / Math.sin((fov * Math.PI) / 360) * 1.08;
  const dir: Vec3 = [0.62, 0.42, 0.66];
  const l = Math.hypot(...dir);
  const eye = center.map((c, i) => c + dir[i] / l * distance) as Vec3;
  const camera = lookAtCamera(eye, center, {
    fov,
    near: Math.max(0.001, distance - radius * 1.5),
    far: distance + radius * 3,
  }, 1);
  const view = renderer.createView({ width: size, height: size });
  try {
    const overlays = {
      still: true,
      temporal: false,
      grid: false as const,
      shading: "lit" as const,
      background: [0.2, 0.21, 0.23, 1] as [number, number, number, number],
      environment: scene.environment,
    };
    // Textures load while drawing; draw again until nothing new arrived.
    for (let i = 0; i < 8; i++) {
      const before = assets.version;
      view.render(scene, camera, overlays);
      await assets.settled();
      if (assets.version === before) break;
    }
    view.render(scene, camera, overlays);
    return await view.capture();
  } finally {
    view.dispose();
  }
}
