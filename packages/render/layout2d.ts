/**
 * Turns the 2D draws of a scene into ordered, resolved items: atlas frames
 * become pixel rectangles, animations pick their frame, text becomes glyph
 * quads. Pure and GPU-free, so picking, tools and tests share it with the
 * renderer.
 */
import { type Mat4, mat4, type Ray, type Vec2, type Vec3 } from "@ink/geometry";
import { animationFrame, type Atlas } from "@ink/schema";
import { layoutText } from "./font.ts";
import { srgbToLinear } from "./gpu.ts";
import type {
  RenderScene,
  SpriteDraw,
  TextDraw,
  TilemapDraw,
} from "./types.ts";

export interface Layout2dAssets {
  atlas(path: string): Atlas | undefined;
  textureSize(path: string): [number, number] | undefined;
  /** Start loading a texture so its size becomes known. */
  preload(kind: "mesh" | "texture", path: string): void;
}

interface Base {
  entity: number;
  /** Draw order: layer; then plain items before y-sorted sprites; then world
   * order, or y (lower in front) for y-sorted sprites. */
  sort: [number, number, number];
}

/** A rectangle of an image mapped onto a unit square placed by `matrix`. */
export interface QuadItem extends Base {
  kind: "sprite";
  matrix: Mat4;
  image: string;
  normals?: string;
  /** Normalised rectangle in the image, v down. */
  rect: [number, number, number, number];
  /** Linear rgb and alpha. */
  color: [number, number, number, number];
  flipX: boolean;
  flipY: boolean;
  lit: boolean;
  smooth: boolean;
}

export interface TileItem extends Base {
  kind: "tilemap";
  /** Unit square to the whole map. */
  matrix: Mat4;
  tileset: string;
  image: string;
  normals?: string;
  width: number;
  height: number;
  cell: Vec2;
  data: ArrayLike<number>;
  /** Normalised rectangle per tile id (4 floats each); id 0 is unused. */
  rects: Float32Array;
  /** Tile flags per tile id. */
  flags: ArrayLike<number>;
  color: [number, number, number, number];
  lit: boolean;
  occluder: boolean;
}

export interface TextItem extends Base {
  kind: "text";
  glyphs: { matrix: Mat4; rect: [number, number, number, number] }[];
  color: [number, number, number, number];
  outline: number;
  outlineColor: [number, number, number, number];
}

export type Item2d = QuadItem | TileItem | TextItem;

const linear = (c: readonly number[]): [number, number, number, number] => [
  srgbToLinear(c[0]),
  srgbToLinear(c[1]),
  srgbToLinear(c[2]),
  c[3] ?? 1,
];

/** The unit square placed at `origin` with size `w` x `h` in the plane of a
 * world matrix. */
function placed(
  world: Mat4,
  x: number,
  y: number,
  w: number,
  h: number,
): Mat4 {
  const local = mat4.identity();
  local[0] = w;
  local[5] = h;
  local[12] = x;
  local[13] = y;
  return mat4.multiply(world, local);
}

/** World size of a sprite's frame, or null while its atlas or image loads. */
export function spriteFrame(
  draw: SpriteDraw,
  assets: Layout2dAssets,
): {
  image: string;
  normals?: string;
  px: [number, number, number, number];
  texture: [number, number];
} | null {
  let image = draw.texture;
  let normals: string | undefined;
  let frame = 0;
  let atlas: Atlas | undefined;
  if (draw.atlas) {
    atlas = assets.atlas(draw.atlas);
    if (!atlas) return null;
    image = atlas.image;
    normals = atlas.normals;
    frame = animationFrame(atlas, draw.anim, draw.animTime, draw.frame);
  }
  if (!image) return null;
  assets.preload("texture", image);
  if (normals) assets.preload("texture", normals);
  const texture = assets.textureSize(image);
  if (!texture) return null;
  const f = atlas?.frames[frame - 1];
  // A frame the atlas no longer has (it was edited) draws nothing, rather
  // than the whole sheet.
  if (atlas && frame > 0 && !f) return null;
  return {
    image,
    normals,
    px: f ? [f.x, f.y, f.w, f.h] : [0, 0, texture[0], texture[1]],
    texture,
  };
}

function spriteItem(
  draw: SpriteDraw,
  assets: Layout2dAssets,
): QuadItem | null {
  const found = spriteFrame(draw, assets);
  if (!found) return null;
  const [x, y, w, h] = found.px;
  const ppu = Math.max(1e-3, draw.pixelsPerUnit);
  const width = w / ppu, height = h / ppu;
  let world = draw.matrix;
  if (draw.snap) {
    // Snap the origin to the image's pixel grid: every sprite shares texels.
    world = Float32Array.from(world);
    world[12] = Math.round(world[12] * ppu) / ppu;
    world[13] = Math.round(world[13] * ppu) / ppu;
  }
  return {
    kind: "sprite",
    entity: draw.entity,
    sort: [
      draw.layer,
      draw.ySort ? 1 : 0,
      draw.ySort ? -draw.matrix[13] : draw.order,
    ],
    matrix: placed(
      world,
      -draw.pivot[0] * width,
      -draw.pivot[1] * height,
      width,
      height,
    ),
    image: found.image,
    normals: found.normals,
    rect: [
      x / found.texture[0],
      y / found.texture[1],
      w / found.texture[0],
      h / found.texture[1],
    ],
    color: linear(draw.color),
    flipX: draw.flipX,
    flipY: draw.flipY,
    lit: draw.lit,
    smooth: draw.smooth,
  };
}

function tileItem(
  draw: TilemapDraw,
  assets: Layout2dAssets,
): TileItem | null {
  if (!draw.tileset) return null;
  const atlas = assets.atlas(draw.tileset);
  if (!atlas) return null;
  assets.preload("texture", atlas.image);
  if (atlas.normals) assets.preload("texture", atlas.normals);
  const texture = assets.textureSize(atlas.image);
  if (!texture) return null;
  const rects = new Float32Array((atlas.frames.length + 1) * 4);
  atlas.frames.forEach((f, i) => {
    rects.set(
      [f.x / texture[0], f.y / texture[1], f.w / texture[0], f.h / texture[1]],
      (i + 1) * 4,
    );
  });
  return {
    kind: "tilemap",
    entity: draw.entity,
    sort: [draw.layer, 0, draw.order],
    matrix: placed(
      draw.matrix,
      0,
      0,
      draw.width * draw.cell[0],
      draw.height * draw.cell[1],
    ),
    tileset: draw.tileset,
    image: atlas.image,
    normals: atlas.normals,
    width: draw.width,
    height: draw.height,
    cell: draw.cell,
    data: draw.data,
    rects,
    flags: atlas.tiles,
    color: linear(draw.color),
    lit: draw.lit,
    occluder: draw.occluder,
  };
}

function textItem(draw: TextDraw): TextItem | null {
  if (!draw.text) return null;
  const layout = layoutText(draw.text, draw.size, draw.align);
  return {
    kind: "text",
    entity: draw.entity,
    sort: [draw.layer, 0, draw.order],
    glyphs: layout.glyphs.map((g) => ({
      matrix: placed(draw.matrix, g.x, g.y, g.w, g.h),
      rect: [g.rect.u, g.rect.v, g.rect.w, g.rect.h],
    })),
    color: linear(draw.color),
    outline: draw.outline,
    outlineColor: linear(draw.outlineColor),
  };
}

/** The scene's 2D content in drawing order (back to front). Items whose
 * atlas or image is still loading are left out and retried next frame. */
export function layout2d(
  scene: RenderScene,
  assets: Layout2dAssets,
): Item2d[] {
  const items: Item2d[] = [];
  for (const draw of scene.sprites ?? []) {
    const item = spriteItem(draw, assets);
    if (item) items.push(item);
  }
  for (const draw of scene.tilemaps ?? []) {
    const item = tileItem(draw, assets);
    if (item) items.push(item);
  }
  for (const draw of scene.texts ?? []) {
    const item = textItem(draw);
    if (item) items.push(item);
  }
  return items.sort((a, b) =>
    a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1] || a.sort[2] - b.sort[2]
  );
}

/** Where a ray meets the unit square placed by `matrix`: (u, v) in 0..1 and
 * the world point, or null. */
export function rayQuad(
  ray: Ray,
  matrix: Mat4,
): { uv: Vec2; point: Vec3; distance: number } | null {
  const inverse = mat4.invert(matrix);
  const o = mat4.transformPoint(inverse, ray.origin);
  const d = mat4.transformDirection(inverse, ray.direction);
  if (Math.abs(d[2]) < 1e-9) return null;
  const t = -o[2] / d[2];
  if (t < 0) return null;
  const u = o[0] + d[0] * t, v = o[1] + d[1] * t;
  if (u < 0 || v < 0 || u > 1 || v > 1) return null;
  const point: Vec3 = [
    ray.origin[0] + ray.direction[0] * t,
    ray.origin[1] + ray.direction[1] * t,
    ray.origin[2] + ray.direction[2] * t,
  ];
  return { uv: [u, v], point, distance: t };
}

/** The topmost 2D item under a ray: its entity, hit point and, for tile
 * maps, the cell. */
export function pick2d(
  items: readonly Item2d[],
  ray: Ray,
): { entity: number; point: Vec3; normal: Vec3; cell?: Vec2 } | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    const hits = item.kind === "text"
      ? item.glyphs.map((g) => rayQuad(ray, g.matrix)).filter(Boolean)
      : [rayQuad(ray, item.matrix)];
    const hit = hits[0];
    if (!hit) continue;
    const normal = mat4.transformDirection(
      item.kind === "text" ? item.glyphs[0].matrix : item.matrix,
      [0, 0, 1],
    );
    const length = Math.hypot(...normal) || 1;
    return {
      entity: item.entity,
      point: hit.point,
      normal: normal.map((n) => n / length) as Vec3,
      cell: item.kind === "tilemap"
        ? [
          Math.min(item.width - 1, Math.floor(hit.uv[0] * item.width)),
          Math.min(item.height - 1, Math.floor(hit.uv[1] * item.height)),
        ]
        : undefined,
    };
  }
  return null;
}
