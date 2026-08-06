declare const entity_brand: unique symbol;

export type EntityDomain = "dynamic" | "fixed";

export interface Entity {
  readonly index: number;
  readonly generation: number;
  readonly domain: EntityDomain;
  readonly [entity_brand]: true;
}

export type EntityLookup =
  | { readonly type: "alive"; readonly entity: Entity }
  | {
    readonly type: "stale";
    readonly entity: Entity;
    readonly actual_generation: number;
    readonly alive: boolean;
  }
  | { readonly type: "outside_domain"; readonly entity: Entity };

export function create_entity(
  index: number,
  generation: number,
  domain: EntityDomain,
): Entity {
  return Object.freeze({ index, generation, domain }) as Entity;
}
