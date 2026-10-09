/**
 * Reading the terrain and scatter entities of a world: which asset each one
 * names and which revision of it the scene expects.
 */
import {
  type Catalog,
  componentOf,
  type EntityModel,
  hasComponent,
  type RecordValue,
} from "@ink/schema";

export interface AssetRef {
  entity: number;
  /** Catalog path of the `heightmap` or `placements` asset. */
  path: string;
  /** The revision the component records (0 when it has none). */
  revision: number;
}

export interface WorldRefs {
  terrains: AssetRef[];
  scatters: AssetRef[];
}

const num = (v: unknown) => typeof v === "number" ? v : 0;

function refOf(
  entity: EntityModel,
  component: string,
  field: string,
  kind: "terrain" | "scatter",
  catalog: Catalog,
): AssetRef | null {
  const c = componentOf(entity, component) as RecordValue | undefined;
  if (!c) return null;
  const path = catalog.assets[kind]?.[num(c[field]) - 1];
  return path ? { entity: entity.id, path, revision: num(c.revision) } : null;
}

/** Every terrain and scatter entity that names an asset. */
export function worldRefs(
  world: { entities: readonly EntityModel[] },
  catalog: Catalog,
): WorldRefs {
  const out: WorldRefs = { terrains: [], scatters: [] };
  for (const entity of world.entities) {
    if (hasComponent(entity, "terrain")) {
      const ref = refOf(entity, "terrain", "heightmap", "terrain", catalog);
      if (ref) out.terrains.push(ref);
    }
    if (hasComponent(entity, "scatter")) {
      const ref = refOf(entity, "scatter", "placements", "scatter", catalog);
      if (ref) out.scatters.push(ref);
    }
  }
  return out;
}
