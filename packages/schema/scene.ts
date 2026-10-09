/**
 * Scene files are the durable, readable form of a world: JSON keyed by field
 * names, with assets as paths and messages as names. Packed state is a
 * session's working form; scenes survive schema changes because fields are
 * matched by name, missing ones take defaults and unknown ones are dropped.
 */
import {
  conformRecord,
  type EntityModel,
  type RecordValue,
  type Value,
  type WorldModel,
} from "./codec.ts";
import type { AtlasInfo } from "./atlas.ts";
import type { Node, RecordSchema, Schema } from "./schema.ts";
import { textId, validateTextIds } from "./text.ts";

export interface SceneEntity {
  id: number;
  name?: string;
  /** Used only when the guest supplies a name symbol with no known host text. */
  nameId?: number;
  parent?: number;
  components: Record<string, unknown>;
}

export interface SceneFile {
  ink: 1;
  tick?: number;
  seed?: number;
  nextEntity?: number;
  entities: SceneEntity[];
  resources?: Record<string, unknown>;
}

/** Asset paths by kind. An asset's id is its position plus one; 0 is none. */
export interface Catalog {
  assets: Record<string, string[]>;
  /** Frames, animations and tile flags of each `atlas` asset, by path. */
  atlases?: Record<string, AtlasInfo>;
}

export const emptyCatalog: Catalog = { assets: {} };

export interface Loaded {
  world: WorldModel;
  names: Map<number, string>;
  problems: string[];
}

type Visit = (node: Node, value: Value, path: string) => Value;

/** Rewrite every asset and message field of a value. */
function mapRefs(node: Node, value: Value, visit: Visit, path: string): Value {
  switch (node.kind) {
    case "asset":
    case "message":
      return visit(node, value, path);
    case "struct": {
      const record = value as RecordValue;
      return Object.fromEntries(
        node.fields.map((f) => [
          f.name,
          mapRefs(f.node, record[f.name], visit, `${path}.${f.name}`),
        ]),
      );
    }
    case "list":
      return (value as Value[]).map((item, i) =>
        mapRefs(node.element, item, visit, `${path}[${i}]`)
      );
    default:
      return value;
  }
}

function mapRecord(
  record: RecordSchema,
  value: RecordValue,
  visit: Visit,
  path: string,
  saving = false,
): RecordValue {
  return Object.fromEntries(
    record.fields.filter((f) =>
      !(saving && (f.node.field as { transient?: boolean }).transient)
    ).map((f) => [
      f.name,
      mapRefs(f.node, value[f.name], visit, `${path}.${f.name}`),
    ]),
  );
}

/** A record written like a scene file (asset paths, message names, missing
 * fields) as a complete record of ids and defaults. */
export function recordFromScene(
  schema: Schema,
  record: RecordSchema,
  raw: unknown,
  catalog: Catalog,
  problems: string[] = [],
): RecordValue {
  return resolveRaw(schema, record, raw, catalog, problems, record.name);
}

/** Resolve names in a raw record (paths, message names) to ids before
 * conforming it, since conform only accepts numbers for references. */
function resolveRaw(
  schema: Schema,
  record: RecordSchema,
  raw: unknown,
  catalog: Catalog,
  problems: string[],
  path: string,
): RecordValue {
  const source = typeof raw === "object" && raw !== null
    ? raw as Record<string, unknown>
    : {};
  const resolveNode = (node: Node, value: unknown, at: string): unknown => {
    if (value === undefined) return value;
    switch (node.kind) {
      case "asset": {
        if (typeof value !== "string") return value;
        if (value === "") return 0;
        const kind = (node.field as { asset: string }).asset;
        const index = catalog.assets[kind]?.indexOf(value) ?? -1;
        if (index < 0) {
          problems.push(`${at}: unknown ${kind} asset "${value}"`);
          return 0;
        }
        return index + 1;
      }
      case "message": {
        if (typeof value !== "string") return value;
        const message = schema.messages.find((m) => m.name === value);
        if (!message) problems.push(`${at}: unknown message "${value}"`);
        return message?.id ?? 0;
      }
      case "struct": {
        if (typeof value !== "object" || value === null) return value;
        const object = value as Record<string, unknown>;
        return Object.fromEntries(
          node.fields.map((
            f,
          ) => [
            f.name,
            resolveNode(f.node, object[f.name], `${at}.${f.name}`),
          ]),
        );
      }
      case "list":
        return Array.isArray(value)
          ? value.map((item, i) =>
            resolveNode(node.element, item, `${at}[${i}]`)
          )
          : value;
      default:
        return value;
    }
  };
  const resolved = Object.fromEntries(
    record.fields.map((f) => [
      f.name,
      resolveNode(f.node, source[f.name], `${path}.${f.name}`),
    ]),
  );
  for (const key of Object.keys(source)) {
    if (!record.fields.some((f) => f.name === key)) {
      problems.push(`${path}.${key}: not in schema, dropped`);
    }
  }
  return conformRecord(record, resolved, problems, path);
}

export function sceneToWorld(
  schema: Schema,
  scene: SceneFile,
  catalog: Catalog,
): Loaded {
  const problems: string[] = [];
  const names = new Map<number, string>();
  const seen = new Set<number>();
  const entities: EntityModel[] = [];
  let highest = 0;
  validateTextIds([
    ...schema.names.map((n) => n.text),
    ...scene.entities.map((e) => e.name ?? ""),
  ]);
  for (const raw of scene.entities ?? []) {
    const id = raw.id;
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) {
      problems.push(`entity ${id}: invalid or duplicate id, dropped`);
      continue;
    }
    seen.add(id);
    highest = Math.max(highest, id);
    const nameId = raw.name ? textId(raw.name) : raw.nameId ?? 0;
    const text = raw.name ?? schema.names.find((n) => n.id === nameId)?.text;
    if (text) names.set(id, text);
    const components: Record<string, RecordValue> = {};
    for (const [name, value] of Object.entries(raw.components ?? {})) {
      const component = schema.component(name);
      if (!component) {
        problems.push(
          `entity ${id}: component "${name}" not in schema, dropped`,
        );
        continue;
      }
      components[name] = resolveRaw(
        schema,
        component,
        value,
        catalog,
        problems,
        `entity ${id} ${name}`,
      );
    }
    entities.push({
      id,
      parent: raw.parent ?? 0,
      ...(nameId ? { nameId } : {}),
      components,
    });
  }
  for (const entity of entities) {
    if (entity.parent !== 0 && !seen.has(entity.parent)) {
      problems.push(`entity ${entity.id}: parent ${entity.parent} missing`);
      entity.parent = 0;
    }
  }
  const resources: Record<string, RecordValue> = {};
  for (const resource of schema.resources) {
    resources[resource.name] = resolveRaw(
      schema,
      resource,
      scene.resources?.[resource.name],
      catalog,
      problems,
      `resource ${resource.name}`,
    );
  }
  const world: WorldModel = {
    tick: scene.tick ?? 0,
    nextEntity: Math.max(scene.nextEntity ?? 1, highest + 1),
    seed: (scene.seed ?? 0x9e3779b9) >>> 0,
    entities,
    resources,
  };
  return { world, names, problems };
}

export function worldToScene(
  schema: Schema,
  world: WorldModel,
  names: ReadonlyMap<number, string>,
  catalog: Catalog,
): SceneFile {
  const visit: Visit = (node, value) => {
    const id = value as number;
    if (node.kind === "message") {
      return schema.messages.find((m) => m.id === id)?.name ?? "";
    }
    if (id === 0) return "";
    const kind = (node.field as { asset: string }).asset;
    return catalog.assets[kind]?.[id - 1] ?? "";
  };
  return {
    ink: 1,
    tick: world.tick,
    seed: world.seed,
    nextEntity: world.nextEntity,
    entities: world.entities.map((entity) => {
      const scene: SceneEntity = { id: entity.id, components: {} };
      const savedName = names.get(entity.id);
      const name = savedName && textId(savedName) === entity.nameId
        ? savedName
        : schema.names.find((n) => n.id === entity.nameId)?.text;
      if (name) scene.name = name;
      else if (entity.nameId) scene.nameId = entity.nameId;
      if (entity.parent) scene.parent = entity.parent;
      scene.components = Object.fromEntries(
        schema.components.flatMap((component) => {
          const value = entity.components[component.name];
          return value
            ? [[
              component.name,
              mapRecord(component, value, visit, component.name, true),
            ]]
            : [];
        }),
      );
      return scene;
    }),
    resources: Object.fromEntries(
      schema.resources.map((resource) => [
        resource.name,
        mapRecord(
          resource,
          world.resources[resource.name],
          visit,
          resource.name,
          true,
        ),
      ]),
    ),
  };
}

/** Move a world between schemas or catalogs through its scene form. */
export function migrateWorld(
  from: { schema: Schema; catalog: Catalog },
  to: { schema: Schema; catalog: Catalog },
  world: WorldModel,
  names: ReadonlyMap<number, string> = new Map(),
): Loaded {
  const loaded = sceneToWorld(
    to.schema,
    worldToScene(from.schema, world, names, from.catalog),
    to.catalog,
  );
  loaded.world.tick = world.tick;
  return loaded;
}

/** Look up an asset path by kind and id. */
export function assetPath(
  catalog: Catalog,
  kind: string,
  id: number,
): string | undefined {
  return id > 0 ? catalog.assets[kind]?.[id - 1] : undefined;
}

export function assetId(catalog: Catalog, kind: string, path: string): number {
  return (catalog.assets[kind]?.indexOf(path) ?? -1) + 1;
}
