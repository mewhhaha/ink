/**
 * The scene side of a stroke. The data (heights, splat weights, placements)
 * changes while the pointer drags; when the drag ends, one session edit
 * records the data's new `revision` in the entity's component (and, for a
 * terrain, refreshes the collision grid), so undo, redo, the timeline and
 * hand-offs carry the data along (see `sync.ts`).
 */
import type { Session } from "@ink/core";
import type { ScatterResource, TerrainResource } from "@ink/render";
import type { TerrainRect } from "@ink/geometry";
import type { RecordValue } from "@ink/schema";
import { updateGrid } from "./grid.ts";
import { worldRefs } from "./world.ts";

type Recipe = Parameters<Session["edit"]>[1];

function componentIn(
  world: Parameters<Recipe>[0],
  entity: number,
  name: string,
): RecordValue {
  const found = world.entities.find((e) => e.id === entity)?.components[name];
  if (!found) throw new Error(`entity ${entity} has no ${name} component`);
  return found;
}

/** Record a finished terrain stroke as one undo step. If the session refuses
 * the edit, the data goes back to `previous` so both stay together. */
export function commitTerrain(
  session: Session,
  entity: number,
  resource: TerrainResource,
  done: { revision: number; area: TerrainRect | null },
  previous: number,
  label: string,
): boolean {
  const ok = session.edit(label, (world) => {
    const t = componentIn(world, entity, "terrain");
    if (resource.field) updateGrid(t, resource.field, done.area);
    t.revision = done.revision;
  });
  if (!ok) resource.seek(previous);
  return ok;
}

/** Record a finished scatter stroke as one undo step. */
export function commitScatter(
  session: Session,
  entity: number,
  resource: ScatterResource,
  revision: number,
  previous: number,
  label: string,
): boolean {
  const ok = session.edit(label, (world) => {
    componentIn(world, entity, "scatter").revision = revision;
  });
  if (!ok) resource.seek(previous);
  return ok;
}

/** Recompute the collision grid of terrains from their heightmaps, as one
 * undo step. `entities` limits it; the default is every terrain whose data
 * has loaded. Returns how many were rebuilt. */
export function rebuildCollisionGrids(
  session: Session,
  assets: { terrain(path: string): TerrainResource },
  entities?: readonly number[],
): number {
  const targets = worldRefs(session.world, session.catalog).terrains
    .filter((t) => !entities || entities.includes(t.entity))
    .flatMap((t) => {
      const field = assets.terrain(t.path).field;
      return field ? [{ entity: t.entity, field }] : [];
    });
  if (!targets.length) return 0;
  const ok = session.edit("Rebuild collision grid", (world) => {
    for (const { entity, field } of targets) {
      updateGrid(componentIn(world, entity, "terrain"), field);
    }
  });
  return ok ? targets.length : 0;
}
