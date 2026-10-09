/**
 * Atlas files (`*.atlas.json`): an image sliced into named frames, with
 * animations and per-frame tile properties. The same file serves sprites,
 * tilesets and the generated Blot constants.
 *
 *   {
 *     "ink": 1,
 *     "image": "tiles.png",            // relative to this file
 *     "normals": "tiles_n.png",        // optional, same layout: 2D lighting
 *     "grid": { "cell": [16, 16], "columns": 8, "rows": 4 },
 *     "names": { "ground": 0, "dirt": 1 },          // grid cell index -> name
 *     "frames": { "hero_idle": [0, 64, 16, 24] },   // free rectangles
 *     "animations": { "hero_run": { "frames": ["hero_run_0"], "fps": 10 } },
 *     "tiles": { "ground": ["solid"], "platform": ["oneway"] },
 *     "autotile": { "ground": { "connects": ["ground"], "tiles": [16 names] } }
 *   }
 *
 * Frame ids are 1-based: the grid cells row by row, then the free rectangles
 * in file order. Id 0 means "the whole image" in sprites and "empty" in tile
 * maps. Animation ids are 1-based too. Blot sees both as generated constants.
 */

export const TILE_SOLID = 1;
export const TILE_ONEWAY = 2;
export const TILE_LADDER = 4;
export const TILE_HAZARD = 8;

export const TILE_FLAGS: Record<string, number> = {
  solid: TILE_SOLID,
  oneway: TILE_ONEWAY,
  ladder: TILE_LADDER,
  hazard: TILE_HAZARD,
};

export interface AtlasFrame {
  name: string;
  /** Pixel rectangle in the image, y down. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AtlasAnimation {
  name: string;
  /** 1-based frame ids. */
  frames: number[];
  fps: number;
  loop: boolean;
}

export interface Autotile {
  /** Tile names (or frame ids) that join to each other. */
  connects: number[];
  /** Frame ids for neighbour masks 0..15 (N=1, E=2, S=4, W=8). */
  tiles: number[];
}

export interface Atlas {
  /** Image path relative to the assets root. */
  image: string;
  normals?: string;
  /** Grid cell size when the atlas has a grid. */
  cell?: [number, number];
  frames: AtlasFrame[];
  animations: AtlasAnimation[];
  /** Tile flags per frame id (index 0 is unused). */
  tiles: number[];
  autotile: Record<string, Autotile>;
}

/** What the catalog knows about an atlas: names for the generated Blot
 * constants, and enough for editors to draw palettes and auto-tile. */
export interface AtlasInfo {
  frames: string[];
  animations: string[];
  /** Tile flags per frame id; index 0 is the empty tile. */
  tiles: number[];
  /** Image path (relative to the assets root) and each frame's pixel rect. */
  image: string;
  rects: [number, number, number, number][];
  autotile: Record<string, Autotile>;
}

export class AtlasError extends Error {
  override name = "AtlasError";
}

const isNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

function join(dir: string, path: string): string {
  const parts = (dir ? dir.split("/") : []).filter(Boolean);
  for (const part of path.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "." && part !== "") parts.push(part);
  }
  return parts.join("/");
}

const dirOf = (path: string) =>
  path.slice(0, Math.max(0, path.lastIndexOf("/")));

/** Parse an atlas file. `path` is the atlas's own catalog path, which its
 * image paths are relative to. Throws `AtlasError` with a readable message. */
export function parseAtlas(text: string, path: string): Atlas {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new AtlasError(`${path}: invalid JSON (${error})`);
  }
  if (typeof raw !== "object" || raw === null) {
    throw new AtlasError(`${path}: expected an object`);
  }
  if (typeof raw.image !== "string" || raw.image === "") {
    throw new AtlasError(`${path}: "image" is required`);
  }
  const dir = dirOf(path);
  const frames: AtlasFrame[] = [];
  const taken = new Set<string>();
  const add = (frame: AtlasFrame) => {
    if (taken.has(frame.name)) {
      throw new AtlasError(`${path}: duplicate frame "${frame.name}"`);
    }
    taken.add(frame.name);
    frames.push(frame);
  };
  let cell: [number, number] | undefined;
  const grid = raw.grid as Record<string, unknown> | undefined;
  if (grid !== undefined) {
    const size = grid.cell as unknown[];
    if (
      !Array.isArray(size) || size.length !== 2 || !size.every(isNumber) ||
      size[0] <= 0 || size[1] <= 0
    ) throw new AtlasError(`${path}: grid.cell must be [width, height]`);
    const columns = Number(grid.columns), rows = Number(grid.rows);
    if (
      !Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 ||
      rows < 1
    ) throw new AtlasError(`${path}: grid needs positive columns and rows`);
    cell = [size[0] as number, size[1] as number];
    const margin = isNumber(grid.margin) ? grid.margin : 0;
    const spacing = isNumber(grid.spacing) ? grid.spacing : 0;
    const names = new Map<number, string>();
    for (
      const [name, index] of Object.entries(
        (raw.names ?? {}) as Record<string, unknown>,
      )
    ) {
      if (!Number.isInteger(index) || (index as number) < 0) {
        throw new AtlasError(`${path}: names.${name} must be a cell index`);
      }
      names.set(index as number, name);
    }
    for (let i = 0; i < columns * rows; i++) {
      add({
        name: names.get(i) ?? `cell_${i}`,
        x: margin + (i % columns) * (cell[0] + spacing),
        y: margin + Math.floor(i / columns) * (cell[1] + spacing),
        w: cell[0],
        h: cell[1],
      });
    }
  }
  for (
    const [name, rect] of Object.entries(
      (raw.frames ?? {}) as Record<string, unknown>,
    )
  ) {
    if (
      !Array.isArray(rect) || rect.length !== 4 || !rect.every(isNumber) ||
      rect[2] <= 0 || rect[3] <= 0
    ) throw new AtlasError(`${path}: frames.${name} must be [x, y, w, h]`);
    add({ name, x: rect[0], y: rect[1], w: rect[2], h: rect[3] });
  }
  for (const frame of frames) {
    if (!/^[a-z_][a-z0-9_]*$/.test(frame.name)) {
      throw new AtlasError(
        `${path}: frame name "${frame.name}" must be lower_snake_case`,
      );
    }
  }
  const idOf = (ref: unknown, where: string): number => {
    const id = typeof ref === "number"
      ? ref
      : frames.findIndex((f) => f.name === ref) + 1;
    if (!Number.isInteger(id) || id < 1 || id > frames.length) {
      throw new AtlasError(`${path}: ${where} names unknown frame ${ref}`);
    }
    return id;
  };
  const animations: AtlasAnimation[] = [];
  for (
    const [name, value] of Object.entries(
      (raw.animations ?? {}) as Record<string, Record<string, unknown>>,
    )
  ) {
    const list = value.frames;
    if (!Array.isArray(list) || list.length === 0) {
      throw new AtlasError(`${path}: animation ${name} needs frames`);
    }
    animations.push({
      name,
      frames: list.map((f) => idOf(f, `animation ${name}`)),
      fps: isNumber(value.fps) && value.fps > 0 ? value.fps : 8,
      loop: value.loop !== false,
    });
  }
  const tiles = new Array<number>(frames.length + 1).fill(0);
  for (
    const [name, flags] of Object.entries(
      (raw.tiles ?? {}) as Record<string, unknown>,
    )
  ) {
    const list = Array.isArray(flags) ? flags : [flags];
    let bits = 0;
    for (const flag of list) {
      const bit = TILE_FLAGS[String(flag)];
      if (!bit) throw new AtlasError(`${path}: unknown tile flag "${flag}"`);
      bits |= bit;
    }
    tiles[idOf(name, "tiles")] = bits;
  }
  const autotile: Record<string, Autotile> = {};
  for (
    const [name, value] of Object.entries(
      (raw.autotile ?? {}) as Record<string, Record<string, unknown>>,
    )
  ) {
    const table = value.tiles;
    if (!Array.isArray(table) || table.length !== 16) {
      throw new AtlasError(`${path}: autotile ${name} needs 16 tiles`);
    }
    autotile[name] = {
      // By default the tiles of a rule join each other.
      connects: [
        ...new Set(
          ((value.connects as unknown[]) ?? table).map((f) =>
            idOf(f, `autotile ${name}`)
          ),
        ),
      ],
      tiles: table.map((f) => idOf(f, `autotile ${name}`)),
    };
  }
  return {
    image: join(dir, raw.image),
    ...(typeof raw.normals === "string"
      ? { normals: join(dir, raw.normals) }
      : {}),
    ...(cell ? { cell } : {}),
    frames,
    animations,
    tiles,
    autotile,
  };
}

export function atlasInfo(atlas: Atlas): AtlasInfo {
  return {
    frames: atlas.frames.map((f) => f.name),
    animations: atlas.animations.map((a) => a.name),
    tiles: atlas.tiles,
    image: atlas.image,
    rects: atlas.frames.map((f) => [f.x, f.y, f.w, f.h]),
    autotile: atlas.autotile,
  };
}

/** Frame id of the animation `anim` (1-based, 0 = none) at `time` seconds. */
export function animationFrame(
  atlas: Atlas,
  anim: number,
  time: number,
  fallback: number,
): number {
  const a = atlas.animations[anim - 1];
  if (!a) return fallback;
  const step = Math.max(0, Math.floor(time * a.fps));
  return a
    .frames[
      a.loop ? step % a.frames.length : Math.min(step, a.frames.length - 1)
    ];
}

// Tile data --------------------------------------------------------------------

/** Tile id at a cell; row 0 is the bottom row. Out of range reads as 0. */
export function tileAt(
  data: ArrayLike<number>,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  return x < 0 || y < 0 || x >= width || y >= height ? 0 : data[y * width + x];
}

/** The neighbour mask autotiling uses: N=1, E=2, S=4, W=8 (+y is north). */
export function autotileMask(
  data: ArrayLike<number>,
  width: number,
  height: number,
  x: number,
  y: number,
  connects: ReadonlySet<number>,
): number {
  const joins = (dx: number, dy: number) => {
    const nx = x + dx, ny = y + dy;
    // Beyond the edge the map continues: edges join their own kind.
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) return true;
    return connects.has(data[ny * width + nx]);
  };
  return (joins(0, 1) ? 1 : 0) | (joins(1, 0) ? 2 : 0) |
    (joins(0, -1) ? 4 : 0) | (joins(-1, 0) ? 8 : 0);
}
