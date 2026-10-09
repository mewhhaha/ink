/**
 * Which terrain and scatter entity a tool edits, and the data behind them.
 *
 * Sculpt and paint tools edit the selected terrain; with none selected, the
 * terrain under the pointer. The panel can pin one (`terrainTargets`). The
 * scatter tool edits the selected scatter entity, the pinned one, or else the
 * first in the scene, and puts instances on the first terrain, which is the
 * ground the renderer places `follow_terrain` instances on.
 */
import type { Ray, TerrainParams, Vec3 } from "@ink/geometry";
import {
  type ScatterResource,
  TERRAIN_LEAF,
  type TerrainDraw,
  type TerrainResource,
} from "@ink/render";
import type { ViewportContext } from "@ink/react";
import { hasComponent } from "@ink/schema";
import {
  raycastTerrain,
  raycastTerrains,
  type TerrainHit,
  type TerrainSurface,
} from "./raycast.ts";
import type { Ground } from "./sculpt.ts";
import { terrainTargets } from "./state.ts";

export interface TerrainTarget {
  entity: number;
  path: string;
  draw: TerrainDraw;
  resource: TerrainResource;
  ground: Ground;
  params: TerrainParams;
  /** World position of the terrain's centre. */
  origin: Vec3;
  surface: TerrainSurface;
}

/** The terrains of the scene whose data has loaded. */
export function readyTerrains(ctx: ViewportContext): TerrainTarget[] {
  const assets = ctx.assets;
  if (!assets) return [];
  const out: TerrainTarget[] = [];
  for (const draw of ctx.scene.terrains ?? []) {
    const resource = assets.terrain(draw.heightmap);
    const field = resource.field;
    if (!field) continue;
    const params = {
      size: draw.size,
      heightScale: draw.heightScale,
      detail: draw.detail,
    };
    out.push({
      entity: draw.entity,
      path: draw.heightmap,
      draw,
      resource,
      ground: { field, size: draw.size },
      params,
      origin: draw.position,
      surface: {
        field,
        params,
        origin: draw.position,
        bounds: (x0, z0, x1, z1) => resource.boundsOf(x0, z0, x1, z1),
        leaf: TERRAIN_LEAF,
      },
    });
  }
  return out;
}

/** Where the ray through a pointer meets one terrain. */
export function hitTerrain(
  ctx: ViewportContext,
  target: TerrainTarget,
  pointer: { x: number; y: number },
): TerrainHit | null {
  return raycastTerrain(ctx.ray(pointer.x, pointer.y), target.surface);
}

/** The terrain a sculpt tool edits and where the ray meets it. */
export function pickTerrain(
  ctx: ViewportContext,
  ray: Ray,
): { target: TerrainTarget; hit: TerrainHit } | null {
  const targets = readyTerrains(ctx);
  const pinned = terrainTargets.get().terrain;
  const wanted = targets.find((t) => t.entity === pinned) ??
    targets.find((t) => ctx.session.selection.includes(t.entity));
  if (wanted) {
    const hit = raycastTerrain(ray, wanted.surface);
    return hit ? { target: wanted, hit } : null;
  }
  const found = raycastTerrains(ray, targets.map((t) => t.surface));
  return found ? { target: targets[found.index], hit: found.hit } : null;
}

export interface ScatterTarget {
  entity: number;
  path: string;
  resource: ScatterResource;
  /** World position of the layer's origin; placements are relative to it. */
  origin: Vec3;
  followTerrain: boolean;
}

const scans = new WeakMap<object, number[]>();

/** The scatter entities of the world, found once per world state. */
function scatterEntities(ctx: ViewportContext): number[] {
  const state = ctx.session.state;
  let found = scans.get(state);
  if (!found) {
    found = ctx.session.world.entities.filter((e) => hasComponent(e, "scatter"))
      .map((e) => e.id);
    scans.set(state, found);
  }
  return found;
}

export function scatterTarget(ctx: ViewportContext): ScatterTarget | null {
  const assets = ctx.assets;
  if (!assets) return null;
  const all = scatterEntities(ctx);
  const pinned = terrainTargets.get().scatter;
  const id = all.find((e) => e === pinned) ??
    all.find((e) => ctx.session.selection.includes(e)) ?? all[0];
  if (id === undefined) return null;
  const c = ctx.session.entity(id)?.components.scatter;
  const matrix = ctx.scene.matrices.get(id);
  const path = ctx.session.catalog.assets.scatter?.[
    Number(c?.placements) - 1
  ];
  if (!c || !matrix || !path) return null;
  return {
    entity: id,
    path,
    resource: assets.scatter(path),
    origin: [matrix[12], matrix[13], matrix[14]],
    followTerrain: c.follow_terrain !== false,
  };
}
