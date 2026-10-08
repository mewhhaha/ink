/**
 * Turns a world into draw lists: resolves the transform hierarchy and the
 * standard components (`transform`, `mesh`, `brush`, `light`, `camera`) into
 * paths, materials and world matrices. Pure and GPU-free, so it also serves
 * tools that only need world matrices or bounds.
 */
import {
  type Aabb,
  aabbEmpty,
  aabbIsEmpty,
  aabbTransform,
  aabbUnion,
  type Mat4,
  mat4,
  type Quat,
  quat,
  type Vec2,
  type Vec3,
  vec3,
  type Vec4,
} from "@ink/geometry";
import {
  brushEdges,
  type BrushFace,
  brushMesh,
  brushPolygons,
  builtinMesh,
  meshBounds,
} from "@ink/geometry";
import {
  assetPath,
  type Catalog,
  type RecordValue,
  type WorldModel,
} from "@ink/schema";
import { defaultEnvironment, readEnvironment } from "./environment.ts";
import type {
  BrushDraw,
  BrushGeometry,
  BrushPart,
  Draw,
  Environment,
  LightDraw,
  RenderMeshData,
  RenderScene,
  SceneCamera,
} from "./types.ts";

const builtinBounds = new Map<string, Aabb>();

/** Local bounds of a mesh path when known without loading it. */
function knownBounds(path: string): Aabb {
  let box = builtinBounds.get(path);
  if (!box) {
    const mesh = builtinMesh(path);
    box = mesh
      ? meshBounds(mesh)
      : { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] };
    builtinBounds.set(path, box);
  }
  return box;
}

// Brush geometry is cached by face content, so an unchanged brush costs only a
// map lookup per frame and keeps its GPU buffers.
const brushCache = new Map<string, BrushGeometry>();
const BRUSH_CACHE_LIMIT = 2048;

function hash(text: string): string {
  // cyrb53: small, fast and well distributed; the key also embeds the length.
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) +
    text.length.toString(36);
}

function brushGeometry(
  faces: BrushFace[],
  texturePath: (id: number) => string | undefined,
): BrushGeometry | null {
  const signature = JSON.stringify(
    faces.map((f) => [
      f.plane,
      texturePath(f.texture) ?? "",
      f.color,
      f.offset,
      f.scale,
      f.rotation,
      f.uv_u,
      f.uv_v,
    ]),
  );
  const key = `brush:${hash(signature)}`;
  const cached = brushCache.get(key);
  if (cached) return cached;
  const planes = faces.map((f) => f.plane);
  const polygons = brushPolygons(planes);
  if (polygons.every((p) => p.length < 3)) return null;

  // UVs stay in texels (size [1, 1]); the view divides by the real size.
  const full = brushMesh(faces, () => [1, 1]);
  const groups = new Map<string, number[]>(); // texture path -> triangle list
  for (let t = 0; t < full.faceOfTriangle.length; t++) {
    const path = texturePath(faces[full.faceOfTriangle[t]].texture) ?? "";
    let list = groups.get(path);
    if (!list) groups.set(path, list = []);
    list.push(t);
  }
  const parts: BrushPart[] = [];
  for (const [path, triangles] of groups) {
    const remap = new Map<number, number>();
    const positions: number[] = [], normals: number[] = [], uvs: number[] = [];
    const colors: number[] = [], faceIds: number[] = [], indices: number[] = [];
    for (const t of triangles) {
      for (let k = 0; k < 3; k++) {
        const old = full.indices[t * 3 + k];
        let next = remap.get(old);
        if (next === undefined) {
          next = remap.size;
          remap.set(old, next);
          positions.push(...full.positions.subarray(old * 3, old * 3 + 3));
          normals.push(...full.normals.subarray(old * 3, old * 3 + 3));
          uvs.push(...full.uvs.subarray(old * 2, old * 2 + 2));
          colors.push(...full.colors.subarray(old * 4, old * 4 + 4));
          faceIds.push(full.faceOfVertex[old]);
        }
        indices.push(next);
      }
    }
    const mesh: RenderMeshData = {
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      uvs: new Float32Array(uvs),
      indices: new Uint32Array(indices),
      colors: new Float32Array(colors),
      faces: new Uint32Array(faceIds),
    };
    parts.push({
      key: `${key}:${parts.length}`,
      texture: path || undefined,
      mesh,
    });
  }
  const bounds = meshBounds(full);
  const geometry: BrushGeometry = {
    key,
    parts,
    edges: brushEdges(planes),
    polygons,
    bounds,
  };
  if (brushCache.size >= BRUSH_CACHE_LIMIT) brushCache.clear();
  brushCache.set(key, geometry);
  return geometry;
}

const vec3Of = (v: unknown, fallback: Vec3): Vec3 =>
  Array.isArray(v) && v.length >= 3 ? [v[0], v[1], v[2]] as Vec3 : fallback;
const vec4Of = (v: unknown, fallback: Vec4): Vec4 =>
  Array.isArray(v) && v.length >= 4
    ? [v[0], v[1], v[2], v[3]] as Vec4
    : fallback;
const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const vec2Of = (v: unknown, fallback: Vec2): Vec2 =>
  Array.isArray(v) && v.length >= 2 ? [v[0], v[1]] as Vec2 : fallback;

function localMatrix(transform: RecordValue | undefined): Mat4 | undefined {
  if (!transform) return undefined;
  const rotation = quat.normalize(
    vec4Of(transform.rotation, [0, 0, 0, 1]) as Quat,
  );
  return mat4.compose(
    vec3Of(transform.position, [0, 0, 0]),
    rotation,
    vec3Of(transform.scale, [1, 1, 1]),
  );
}

/** World matrix of every entity: its local transform composed with the parent
 * chain. Entities without a transform take their parent's matrix. */
export function worldMatrices(world: WorldModel): Map<number, Mat4> {
  const byId = new Map(world.entities.map((e) => [e.id, e]));
  const result = new Map<number, Mat4>();
  const visiting = new Set<number>();
  const resolve = (id: number): Mat4 => {
    const known = result.get(id);
    if (known) return known;
    const entity = byId.get(id);
    if (!entity || visiting.has(id)) return mat4.identity();
    visiting.add(id);
    const parent = entity.parent ? resolve(entity.parent) : mat4.identity();
    const local = localMatrix(entity.components.transform);
    const matrix = local ? mat4.multiply(parent, local) : parent;
    visiting.delete(id);
    result.set(id, matrix);
    return matrix;
  };
  for (const entity of world.entities) resolve(entity.id);
  return result;
}

export function extractScene(
  world: WorldModel,
  catalog: Catalog,
  options: { hidden?: ReadonlySet<number> } = {},
): RenderScene {
  const matrices = worldMatrices(world);
  const hiddenSet = options.hidden;
  const parents = new Map(world.entities.map((e) => [e.id, e.parent]));
  const hiddenCache = new Map<number, boolean>();
  const isHidden = (id: number): boolean => {
    if (!hiddenSet || hiddenSet.size === 0) return false;
    const known = hiddenCache.get(id);
    if (known !== undefined) return known;
    let value = hiddenSet.has(id);
    const parent = parents.get(id);
    if (!value && parent) value = isHidden(parent);
    hiddenCache.set(id, value);
    return value;
  };

  const draws: Draw[] = [];
  const brushes: BrushDraw[] = [];
  const lights: LightDraw[] = [];
  const cameras: SceneCamera[] = [];
  let environment: Environment | undefined;
  let bounds: Aabb = aabbEmpty();
  const texturePath = (id: number) => assetPath(catalog, "texture", id);

  for (const entity of world.entities) {
    const c = entity.components;
    const matrix = matrices.get(entity.id)!;
    if (c.camera) {
      const cam = c.camera;
      cameras.push({
        entity: entity.id,
        matrix,
        camera: {
          fov: cam.fov as number,
          near: cam.near as number,
          far: cam.far as number,
          orthographic: cam.orthographic as boolean,
          size: cam.size as number,
          active: cam.active as boolean,
        },
      });
    }
    if (isHidden(entity.id)) continue;
    if (c.mesh) {
      const m = c.mesh;
      const path = assetPath(catalog, "mesh", m.shape as number);
      if (path) {
        draws.push({
          entity: entity.id,
          mesh: path,
          texture: texturePath(m.texture as number),
          normalMap: texturePath(m.normal_map as number),
          normalStrength: num(m.normal_strength, 1),
          ormMap: texturePath(m.orm_map as number),
          uvScale: vec2Of(m.uv_scale, [1, 1]),
          emissiveStrength: num(m.emissive_strength, 1),
          matrix,
          color: vec4Of(m.color, [1, 1, 1, 1]),
          roughness: m.roughness as number,
          metallic: m.metallic as number,
          emissive: vec4Of(m.emissive, [0, 0, 0, 1]),
          castShadows: m.cast_shadows as boolean,
        });
        bounds = aabbUnion(bounds, aabbTransform(knownBounds(path), matrix));
      }
    }
    if (c.environment && !environment && c.environment.active !== false) {
      environment = readEnvironment(c.environment);
    }
    if (c.brush && c.brush.visible !== false) {
      const faces: BrushFace[] = (c.brush.faces as RecordValue[]).map((f) => ({
        plane: vec4Of(f.plane, [0, 1, 0, 0]),
        texture: f.texture as number,
        color: vec4Of(f.color, [1, 1, 1, 1]),
        offset: vec2Of(f.offset, [0, 0]),
        scale: vec2Of(f.scale, [1, 1]),
        rotation: f.rotation as number,
        uv_u: (f.uv_u ?? [0, 0, 0, 0]) as Vec4,
        uv_v: (f.uv_v ?? [0, 0, 0, 0]) as Vec4,
      }));
      const geometry = brushGeometry(faces, texturePath);
      if (geometry) {
        brushes.push({ entity: entity.id, matrix, geometry });
        bounds = aabbUnion(bounds, aabbTransform(geometry.bounds, matrix));
      }
    }
    if (c.light) {
      const l = c.light;
      lights.push({
        entity: entity.id,
        kind: l.kind as LightDraw["kind"],
        color: vec3Of(l.color, [1, 1, 1]),
        intensity: l.intensity as number,
        range: l.range as number,
        angle: l.angle as number,
        shadows: l.shadows as boolean,
        softness: num(l.softness, 1),
        position: [matrix[12], matrix[13], matrix[14]],
        direction: vec3.normalize(mat4.transformDirection(matrix, [0, 0, -1])),
      });
    }
  }
  return {
    matrices,
    draws,
    brushes,
    lights,
    cameras,
    environment: environment ?? defaultEnvironment(),
    bounds: aabbIsEmpty(bounds) ? null : bounds,
  };
}
