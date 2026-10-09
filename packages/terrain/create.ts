/**
 * Making new terrain and scatter assets from the editor: a flat `.terrain`
 * file written through the dev server, then an entity that uses it.
 */
import {
  overviewCellsOf,
  ScatterSet,
  TERRAIN_MAX_LAYERS,
  terrainLayout,
  writeTerrainHeader,
} from "@ink/geometry";
import type { Ink } from "@ink/react";
import type { Session } from "@ink/core";
import type { Segment } from "./save.ts";

/** Colours of new terrain layers, in order: grass, rock, dirt, sand, snow... */
export const layerPalette: [number, number, number, number][] = [
  [0.36, 0.52, 0.22, 1],
  [0.47, 0.45, 0.42, 1],
  [0.42, 0.31, 0.2, 1],
  [0.78, 0.7, 0.5, 1],
  [0.95, 0.96, 0.98, 1],
  [0.26, 0.32, 0.18, 1],
  [0.6, 0.35, 0.25, 1],
  [0.3, 0.3, 0.33, 1],
];

export const layerNames = [
  "Grass",
  "Rock",
  "Dirt",
  "Sand",
  "Snow",
  "Moss",
  "Clay",
  "Slate",
];

export interface NewTerrain {
  /** File name without extension, under `terrain/`. */
  name: string;
  /** Height samples per side minus one. */
  cells: number;
  /** Side length in metres. */
  size: number;
  layers: number;
  /** Cells per side of the collision grid game code sees. */
  collisionCells: number;
}

/** The bytes of a flat terrain (height 0, the first layer everywhere) as
 * ranges of a zero-filled file of `size` bytes: the header and the first
 * splat plane are all that is not zero. */
export function newTerrainPlan(
  options: { cells: number; layers: number; splatCells?: number },
): { size: number; segments: Segment[] } {
  const splatCells = options.splatCells ?? Math.max(1, options.cells >> 1);
  const header = {
    cells: options.cells,
    splatCells,
    layers: Math.min(TERRAIN_MAX_LAYERS, Math.max(1, options.layers)),
    revision: 0,
    overviewCells: overviewCellsOf(options.cells),
  };
  const layout = terrainLayout(header);
  const plane = new Uint8Array(splatCells * splatCells * 4);
  for (let i = 0; i < splatCells * splatCells; i++) plane[i * 4] = 255;
  return {
    size: layout.end,
    segments: [
      { offset: 0, bytes: writeTerrainHeader(header) },
      { offset: layout.splat, bytes: plane },
    ],
  };
}

/** A file-name-safe version of what the person typed. */
export function assetSlug(name: string): string {
  return name.trim().replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[.-]+/, "")
    .replace(/\.(terrain|scatter)$/i, "").slice(0, 60);
}

/** Resolves when the catalog lists the asset (the dev server announces new
 * files a moment after they are written). */
export function waitForAsset(
  session: Pick<Session, "catalog" | "subscribe">,
  kind: "terrain" | "scatter",
  path: string,
  timeout = 10000,
): Promise<void> {
  const has = () => session.catalog.assets[kind]?.includes(path) ?? false;
  if (has()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`${path} did not show up in the project`));
    }, timeout);
    const off = session.subscribe(() => {
      if (!has()) return;
      clearTimeout(timer);
      off();
      resolve();
    });
  });
}

function dev(ink: Ink) {
  const client = ink.dev?.client;
  if (!client) throw new Error("Creating assets needs the dev server");
  return client;
}

/** Write a flat terrain file and add an entity that shows it. Returns the
 * entity's id. */
export async function createTerrain(
  ink: Ink,
  options: NewTerrain,
): Promise<number> {
  const slug = assetSlug(options.name);
  if (!slug) throw new Error("Give the terrain a name");
  const path = `terrain/${slug}.terrain`;
  const { session } = ink;
  if (session.catalog.assets.terrain?.includes(path)) {
    throw new Error(`${path} already exists`);
  }
  const client = dev(ink);
  const plan = newTerrainPlan(options);
  await client.createAsset(path, plan.size);
  await client.patchAsset(path, plan.segments);
  await waitForAsset(session, "terrain", path);
  const cells = options.collisionCells;
  return session.createEntity({
    name: slug,
    components: {
      transform: { position: [0, 0, 0] },
      terrain: {
        heightmap: path,
        size: options.size,
        layers: Array.from({ length: options.layers }, (_, i) => ({
          color: layerPalette[i % layerPalette.length],
          tiling: 6,
        })),
        collision_cells: cells,
        grid: new Array((cells + 1) ** 2).fill(0),
        revision: 0,
      },
    },
  });
}

/** Write an empty placements file and add a scatter entity for `mesh`. */
export async function createScatter(
  ink: Ink,
  options: { name: string; mesh: string },
): Promise<number> {
  const slug = assetSlug(options.name);
  if (!slug) throw new Error("Give the layer a name");
  const path = `scatter/${slug}.scatter`;
  const { session } = ink;
  if (session.catalog.assets.scatter?.includes(path)) {
    throw new Error(`${path} already exists`);
  }
  await dev(ink).putAsset(path, new ScatterSet(0).serialize(), {
    create: true,
  });
  await waitForAsset(session, "scatter", path);
  return session.createEntity({
    name: slug,
    components: {
      transform: { position: [0, 0, 0] },
      scatter: { shape: options.mesh, placements: path, revision: 0 },
    },
  });
}
