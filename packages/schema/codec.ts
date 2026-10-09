/**
 * The numeric packets exchanged with a Blot guest, and their plain-object
 * models on the host.
 *
 * State packet (all lanes are F32; integers are exact below 2^24):
 *
 *   0 schema hash      1 tick           2 next entity id
 *   3 seed high 16     4 seed low 16    5 entity count N
 *   6 resources offset (from the packet start)
 *   7 .. 7+N           offset of each entity record (from the packet start)
 *   entity records     id, parent, name id, then per component in schema order:
 *                      0, or 1 followed by the component's lanes
 *   resources          each resource's lanes in schema order
 *
 * A list stores its length followed by its elements.
 *
 * Step packet (host -> guest): input lane count, input lanes, state lanes.
 * Step result (guest -> host): state lane count, state lanes, event count,
 * then per event its index and lanes.
 */
import type { Vec2, Vec3, Vec4 } from "./fields.ts";
import type { NamedNode, Node, RecordSchema, Schema } from "./schema.ts";

export type Value =
  | number
  | boolean
  | string
  | Value[]
  | { [field: string]: Value };

export type RecordValue = { [field: string]: Value };

export interface EntityModel {
  id: number;
  /** 0 for a root entity. */
  parent: number;
  /** Host text symbol, exposed as `name_id` in Blot. Missing means unnamed. */
  nameId?: number;
  components: Record<string, RecordValue>;
}

export interface WorldModel {
  tick: number;
  nextEntity: number;
  /** The guest's random state, a full 32-bit value. */
  seed: number;
  entities: EntityModel[];
  resources: Record<string, RecordValue>;
}

export const STATE_HEADER = 7;
export const INPUT_HEADER = 22;
export const MAX_EXACT = 0xffffff;

export class PacketError extends Error {
  override name = "PacketError";
}

// Defaults --------------------------------------------------------------------

export function defaultValue(node: Node): Value {
  const field = node.field;
  switch (node.kind) {
    case "f32":
      return Math.fround((field as { default: number }).default);
    case "u32":
    case "bool":
      return (field as { default: number | boolean }).default;
    case "vec2":
    case "vec3":
    case "vec4":
    case "quat":
    case "color":
      return (field as { default: number[] }).default.map(Math.fround);
    case "entity":
    case "asset":
    case "message":
      return 0;
    case "enum":
      return node.field.default;
    case "struct":
      return Object.fromEntries(
        node.fields.map((f) => [f.name, defaultValue(f.node)]),
      );
    case "list":
      return [];
  }
}

export function defaultRecord(record: RecordSchema): RecordValue {
  return Object.fromEntries(
    record.fields.map((f) => [f.name, defaultValue(f.node)]),
  );
}

export function emptyWorld(schema: Schema, seed = 0x9e3779b9): WorldModel {
  return {
    tick: 0,
    nextEntity: 1,
    seed: seed >>> 0,
    entities: [],
    resources: Object.fromEntries(
      schema.resources.map((r) => [r.name, defaultRecord(r)]),
    ),
  };
}

/** Fill in missing fields with defaults and drop unknown ones. Values of the
 * wrong shape are replaced by defaults and reported. */
export function conform(
  node: Node,
  value: unknown,
  problems: string[] = [],
  path = "",
): Value {
  const fallback = () => {
    if (value !== undefined) problems.push(`${path}: replaced invalid value`);
    return defaultValue(node);
  };
  switch (node.kind) {
    case "f32":
      return typeof value === "number" && Number.isFinite(value)
        ? Math.fround(value)
        : fallback();
    case "u32":
    case "entity":
    case "asset":
    case "message":
      return typeof value === "number" && Number.isInteger(value) &&
          value >= 0 && value <= MAX_EXACT
        ? value
        : fallback();
    case "bool":
      return typeof value === "boolean" ? value : fallback();
    case "vec2":
    case "vec3":
    case "vec4":
    case "quat":
    case "color":
      return Array.isArray(value) && value.length === node.lanes &&
          value.every((x) => typeof x === "number" && Number.isFinite(x))
        ? value.map(Math.fround)
        : fallback();
    case "enum":
      return typeof value === "string" && node.values.includes(value)
        ? value
        : fallback();
    case "struct": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return fallback();
      }
      const source = value as Record<string, unknown>;
      return Object.fromEntries(
        node.fields.map((f) => [
          f.name,
          conform(f.node, source[f.name], problems, `${path}.${f.name}`),
        ]),
      );
    }
    case "list": {
      if (!Array.isArray(value)) return fallback();
      const max = node.field.max ?? MAX_EXACT;
      if (value.length > max) problems.push(`${path}: truncated to ${max}`);
      return value.slice(0, max).map((item, i) =>
        conform(node.element, item, problems, `${path}[${i}]`)
      );
    }
  }
}

export function conformRecord(
  record: RecordSchema,
  value: unknown,
  problems: string[] = [],
  path = record.name,
): RecordValue {
  const source = typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
  return Object.fromEntries(
    record.fields.map((f) => [
      f.name,
      conform(f.node, source[f.name], problems, `${path}.${f.name}`),
    ]),
  );
}

// Plans -----------------------------------------------------------------------
// Each node and record is compiled once into closures that read, write and size
// it, so a step builds no field paths or intermediate arrays.

/** Where the last read stopped; variable-size values report their end here. */
let cursor = 0;

type Read = (l: Float32Array, o: number) => Value;
type Write = (l: Float32Array, o: number, v: Value) => number;
type Size = (v: Value) => number;

interface Plan {
  /** Fixed size in lanes, or null when a list makes it depend on the value. */
  lanes: number | null;
  read: Read;
  write: Write;
  size: Size;
  /** Where a value at `o` ends, without decoding it. */
  end: (l: Float32Array, o: number) => number;
}

const plans = new WeakMap<object, Plan>();

function integer(path: string, value: unknown): number {
  if (
    typeof value !== "number" || !Number.isInteger(value) || value < 0 ||
    value > MAX_EXACT
  ) {
    throw new PacketError(
      `${path} must be an integer from 0 to ${MAX_EXACT}, got ${value}`,
    );
  }
  return value;
}

function unsigned(path: string, x: number): number {
  if (!(x >= 0) || !Number.isInteger(x)) {
    throw new PacketError(`${path} is not an integer: ${x}`);
  }
  return x;
}

function nodePlan(node: Node, path: string): Plan {
  switch (node.kind) {
    case "f32":
      return {
        lanes: 1,
        read: (l, o) => l[o],
        write: (l, o, v) => {
          l[o] = v as number;
          return o + 1;
        },
        size: () => 1,
        end: (_, o) => o + 1,
      };
    case "u32":
    case "entity":
    case "asset":
    case "message":
      return {
        lanes: 1,
        read: (l, o) => unsigned(path, l[o]),
        write: (l, o, v) => {
          l[o] = integer(path, v);
          return o + 1;
        },
        size: () => 1,
        end: (_, o) => o + 1,
      };
    case "bool":
      return {
        lanes: 1,
        read: (l, o) => l[o] !== 0,
        write: (l, o, v) => {
          l[o] = v ? 1 : 0;
          return o + 1;
        },
        size: () => 1,
        end: (_, o) => o + 1,
      };
    case "vec2":
      return vector(2);
    case "vec3":
      return vector(3);
    case "vec4":
    case "quat":
    case "color":
      return vector(4);
    case "enum": {
      const values = node.values;
      return {
        lanes: 1,
        read: (l, o) => values[unsigned(path, l[o])] ?? values[0],
        write: (l, o, v) => {
          const index = values.indexOf(v as string);
          if (index < 0) {
            throw new PacketError(`${path}: "${v}" is not one of ${values}`);
          }
          l[o] = index;
          return o + 1;
        },
        size: () => 1,
        end: (_, o) => o + 1,
      };
    }
    case "struct":
      return fieldsPlan(node.fields, path, node.lanes);
    case "list": {
      const element = nodePlan(node.element, `${path}[]`);
      const width = node.element.lanes;
      return {
        lanes: null,
        read: (l, o) => {
          const count = unsigned(`${path} length`, l[o]);
          if (o + 1 + count * width > l.length) {
            throw new PacketError("packet ended early");
          }
          const items: Value[] = new Array(count);
          let p = o + 1;
          for (let i = 0; i < count; i++, p += width) {
            items[i] = element.read(l, p);
          }
          cursor = p;
          return items;
        },
        write: (l, o, v) => {
          const items = v as Value[];
          l[o] = integer(`${path} length`, items.length);
          let p = o + 1;
          for (let i = 0; i < items.length; i++) {
            p = element.write(l, p, items[i]);
          }
          return p;
        },
        size: (v) => 1 + (v as Value[]).length * width,
        end: (l, o) => o + 1 + unsigned(`${path} length`, l[o]) * width,
      };
    }
  }
}

function vector(n: 2 | 3 | 4): Plan {
  return {
    lanes: n,
    read: n === 2
      ? (l, o) => [l[o], l[o + 1]]
      : n === 3
      ? (l, o) => [l[o], l[o + 1], l[o + 2]]
      : (l, o) => [l[o], l[o + 1], l[o + 2], l[o + 3]],
    write: (l, o, v) => {
      const vec = v as number[];
      for (let i = 0; i < n; i++) l[o + i] = vec[i];
      return o + n;
    },
    size: () => n,
    end: (_, o) => o + n,
  };
}

function fieldsPlan(
  fields: NamedNode[],
  path: string,
  lanes: number | null,
): Plan {
  const names = fields.map((f) => f.name);
  const parts = fields.map((f) => nodePlan(f.node, `${path}.${f.name}`));
  const count = fields.length;
  return {
    lanes,
    read: (l, o) => {
      const out: RecordValue = {};
      let p = o;
      for (let i = 0; i < count; i++) {
        const part = parts[i];
        out[names[i]] = part.read(l, p);
        p = part.lanes === null ? cursor : p + part.lanes;
      }
      cursor = p;
      return out;
    },
    write: (l, o, v) => {
      const record = v as RecordValue;
      let p = o;
      for (let i = 0; i < count; i++) {
        p = parts[i].write(l, p, record[names[i]]);
      }
      return p;
    },
    end: lanes !== null ? (_, o) => o + lanes : (l, o) => {
      let p = o;
      for (let i = 0; i < count; i++) {
        const part = parts[i];
        p = part.lanes === null ? part.end(l, p) : p + part.lanes;
      }
      return p;
    },
    size: lanes !== null ? () => lanes : (v) => {
      const record = v as RecordValue;
      let total = 0;
      for (let i = 0; i < count; i++) {
        total += parts[i].lanes ?? parts[i].size(record[names[i]]);
      }
      return total;
    },
  };
}

function recordPlan(record: RecordSchema, prefix = ""): Plan {
  let plan = plans.get(record);
  if (!plan) {
    plan = fieldsPlan(record.fields, `${prefix}${record.name}`, record.lanes);
    plans.set(record, plan);
  }
  return plan;
}

// Entities and worlds ---------------------------------------------------------

interface Layout {
  names: string[];
  plans: Plan[];
}
const layouts = new WeakMap<Schema, Layout>();

function layoutOf(schema: Schema): Layout {
  let layout = layouts.get(schema);
  if (!layout) {
    layout = {
      names: schema.components.map((c) => c.name),
      plans: schema.components.map((c) => recordPlan(c)),
    };
    layouts.set(schema, layout);
  }
  return layout;
}

function readComponents(
  schema: Schema,
  lanes: Float32Array,
  start: number,
  end: number,
): Record<string, RecordValue> {
  const components: Record<string, RecordValue> = {};
  const layout = layoutOf(schema);
  const count = layout.plans.length;
  let p = start + 3;
  for (let c = 0; c < count; c++) {
    if (lanes[p] !== 0) {
      const plan = layout.plans[c];
      components[layout.names[c]] = plan.read(lanes, p + 1) as RecordValue;
      p = plan.lanes === null ? cursor : p + 1 + plan.lanes;
    } else p++;
  }
  if (p !== end) {
    throw new PacketError(
      `entity ${lanes[start]} record is ${p - start} lanes, expected ${
        end - start
      }`,
    );
  }
  return components;
}

/**
 * An entity decoded straight from a state packet. Its id, parent and name are
 * read at once; its components decode on first use and are then ordinary,
 * changeable records. An entity nobody touched is written back verbatim, so
 * large worlds pay only for what they read or change. `has`, `component` and
 * `componentNames` answer from the packet without decoding the others.
 *
 * The packet must not change while an entity reads from it.
 */
export class PackedEntity implements EntityModel {
  id: number;
  parent: number;
  declare nameId?: number;
  readonly toJSON: () => EntityModel = packedToJSON;
  readonly #schema: Schema;
  readonly #lanes: Float32Array;
  readonly #start: number;
  readonly #end: number;
  #components?: Record<string, RecordValue>;

  constructor(
    schema: Schema,
    lanes: Float32Array,
    start: number,
    end: number,
  ) {
    this.id = unsigned("entity id", lanes[start]);
    this.parent = unsigned("entity parent", lanes[start + 1]);
    const nameId = unsigned("entity name id", lanes[start + 2]);
    if (nameId) this.nameId = nameId;
    this.#schema = schema;
    this.#lanes = lanes;
    this.#start = start;
    this.#end = end;
  }

  get components(): Record<string, RecordValue> {
    return this.#components ??= readComponents(
      this.#schema,
      this.#lanes,
      this.#start,
      this.#end,
    );
  }

  set components(value: Record<string, RecordValue>) {
    this.#components = value;
  }

  /** Whether the components still match the packet they came from. */
  get pristine(): boolean {
    return this.#components === undefined;
  }

  /** Whether the entity has `name`, without decoding anything. */
  has(name: string): boolean {
    if (this.#components) return name in this.#components;
    return this.#locate(name) >= 0;
  }

  /** The names of the entity's components, without decoding them. */
  componentNames(): string[] {
    if (this.#components) return Object.keys(this.#components);
    const names: string[] = [];
    this.#locate("", names);
    return names;
  }

  /** One component, decoding only that. */
  component(name: string): RecordValue | undefined {
    if (this.#components) return this.#components[name];
    const at = this.#locate(name);
    if (at < 0) return undefined;
    const record = this.#schema.component(name)!;
    return recordPlan(record).read(this.#lanes, at) as RecordValue;
  }

  /** The lane after the presence flag of `name`, or -1. */
  #locate(name: string, names?: string[]): number {
    const lanes = this.#lanes;
    const layout = layoutOf(this.#schema);
    const count = layout.plans.length;
    let p = this.#start + 3;
    for (let c = 0; c < count; c++) {
      if (lanes[p] !== 0) {
        if (names) names.push(layout.names[c]);
        else if (layout.names[c] === name) return p + 1;
        const plan = layout.plans[c];
        p = plan.lanes === null ? plan.end(lanes, p + 1) : p + 1 + plan.lanes;
      } else p++;
    }
    return -1;
  }

  /** The component lanes of an untouched entity written for `schema`. */
  packedComponents(schema: Schema): Float32Array | null {
    return this.#components === undefined && schema.hash === this.#schema.hash
      ? this.#lanes.subarray(this.#start + 3, this.#end)
      : null;
  }

  /** An independent entity: changing it never affects this one. */
  fork(): PackedEntity {
    const copy = new PackedEntity(
      this.#schema,
      this.#lanes,
      this.#start,
      this.#end,
    );
    copy.id = this.id;
    copy.parent = this.parent;
    if (this.nameId) copy.nameId = this.nameId;
    else delete copy.nameId;
    if (this.#components) copy.#components = structuredClone(this.#components);
    return copy;
  }
}

/** Serializes a packed entity as plain data. An own, enumerable function also
 * makes `structuredClone` refuse a packed entity instead of silently dropping
 * its components; use `cloneEntity`. */
function packedToJSON(this: EntityModel): EntityModel {
  return plainEntity(this);
}

/** Whether `entity` has `name`; cheap for packed entities. */
export function hasComponent(entity: EntityModel, name: string): boolean {
  return entity instanceof PackedEntity
    ? entity.has(name)
    : name in entity.components;
}

/** One component of `entity`; decodes only that one for packed entities. */
export function componentOf(
  entity: EntityModel,
  name: string,
): RecordValue | undefined {
  return entity instanceof PackedEntity
    ? entity.component(name)
    : entity.components[name];
}

/** Component names of `entity`, without decoding packed entities. */
export function componentNames(entity: EntityModel): string[] {
  return entity instanceof PackedEntity
    ? entity.componentNames()
    : Object.keys(entity.components);
}

/** The entity as plain data, decoding every component. */
export function plainEntity(entity: EntityModel): EntityModel {
  return {
    id: entity.id,
    parent: entity.parent,
    ...(entity.nameId ? { nameId: entity.nameId } : {}),
    components: entity.components,
  };
}

/** The world as plain data: every entity fully decoded. For comparisons and
 * serialization; prefer the lazy entities everywhere else. */
export function plainWorld(world: WorldModel): WorldModel {
  return { ...world, entities: world.entities.map(plainEntity) };
}

/** A world that can be changed without affecting `world`. Untouched packed
 * entities stay packed. */
export function cloneWorld(world: WorldModel): WorldModel {
  return {
    tick: world.tick,
    nextEntity: world.nextEntity,
    seed: world.seed,
    entities: world.entities.map(cloneEntity),
    resources: structuredClone(world.resources),
  };
}

/** An entity that can be changed without affecting `entity`. */
export function cloneEntity(entity: EntityModel): EntityModel {
  return entity instanceof PackedEntity
    ? entity.fork()
    : structuredClone(entity);
}

function entityLanes(
  schema: Schema,
  plans: Plan[],
  entity: EntityModel,
): number {
  const packed = entity instanceof PackedEntity
    ? entity.packedComponents(schema)
    : null;
  if (packed) return 3 + packed.length;
  let size = 3;
  const components = entity.components;
  for (let c = 0; c < plans.length; c++) {
    const value = components[schema.components[c].name];
    size += 1 + (value ? plans[c].lanes ?? plans[c].size(value) : 0);
  }
  return size;
}

export function encodeWorld(schema: Schema, world: WorldModel): Float32Array {
  const entities = world.entities;
  const count = entities.length;
  const plans = schema.components.map((c) => recordPlan(c));
  let size = STATE_HEADER + count;
  const lengths = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    lengths[i] = entityLanes(schema, plans, entities[i]);
    size += lengths[i];
  }
  const resourcesOffset = size;
  const resources = schema.resources.map((r) => {
    const plan = recordPlan(r);
    return { plan, value: world.resources[r.name] };
  });
  for (const { plan, value } of resources) {
    size += plan.lanes ?? plan.size(value);
  }
  const lanes = new Float32Array(size);
  const seed = world.seed >>> 0;
  lanes[0] = schema.hash;
  lanes[1] = integer("tick", world.tick);
  lanes[2] = integer("next entity id", world.nextEntity);
  lanes[3] = seed >>> 16;
  lanes[4] = seed & 0xffff;
  lanes[5] = integer("entity count", count);
  lanes[6] = integer("resources offset", resourcesOffset);
  let at = STATE_HEADER + count;
  for (let i = 0; i < count; i++) {
    const entity = entities[i];
    lanes[STATE_HEADER + i] = integer("entity offset", at);
    lanes[at] = integer("entity id", entity.id);
    lanes[at + 1] = integer(`entity ${entity.id} parent`, entity.parent);
    lanes[at + 2] = integer(`entity ${entity.id} name`, entity.nameId ?? 0);
    const packed = entity instanceof PackedEntity
      ? entity.packedComponents(schema)
      : null;
    if (packed) {
      lanes.set(packed, at + 3);
    } else {
      try {
        let p = at + 3;
        const components = entity.components;
        for (let c = 0; c < plans.length; c++) {
          const value = components[schema.components[c].name];
          if (value) {
            lanes[p] = 1;
            p = plans[c].write(lanes, p + 1, value);
          } else p++;
        }
      } catch (error) {
        if (error instanceof PacketError) {
          throw new PacketError(`entity ${entity.id} ${error.message}`);
        }
        throw error;
      }
    }
    at += lengths[i];
  }
  for (const { plan, value } of resources) {
    try {
      at = plan.write(lanes, at, value);
    } catch (error) {
      if (error instanceof PacketError) {
        throw new PacketError(`resource ${error.message}`);
      }
      throw error;
    }
  }
  return lanes;
}

/** Worlds with more entities than this decode lazily by default. */
export const LAZY_ENTITIES = 1024;

/** Decode a state packet. `start` is where the state begins in `lanes`.
 *
 * A world of up to `LAZY_ENTITIES` entities decodes eagerly into plain
 * objects. A larger one gets `PackedEntity`s, which decode their components on
 * first use, so a step nobody inspects costs no decoding; copy such entities
 * with `cloneEntity`, not a spread or `structuredClone`. `options.lazy`
 * chooses explicitly. */
export function decodeWorld(
  schema: Schema,
  lanes: Float32Array,
  start = 0,
  options: { lazy?: boolean } = {},
): WorldModel {
  if (lanes.length < start + STATE_HEADER) {
    throw new PacketError("packet ended early");
  }
  const hash = lanes[start];
  if (hash !== schema.hash) {
    throw new PacketError(
      `state was written by schema ${hash}, expected ${schema.hash}`,
    );
  }
  const tick = unsigned("tick", lanes[start + 1]);
  const nextEntity = unsigned("next entity id", lanes[start + 2]);
  const seed = ((unsigned("seed", lanes[start + 3]) << 16) |
    unsigned("seed", lanes[start + 4])) >>> 0;
  const count = unsigned("entity count", lanes[start + 5]);
  const resourcesOffset = unsigned("resources offset", lanes[start + 6]);
  if (
    start + resourcesOffset > lanes.length ||
    start + STATE_HEADER + count > lanes.length
  ) throw new PacketError("packet ended early");
  const lazy = options.lazy ?? count > LAZY_ENTITIES;
  const entities: EntityModel[] = new Array(count);
  let next = count > 0
    ? start + unsigned("entity offset", lanes[start + STATE_HEADER])
    : 0;
  for (let i = 0; i < count; i++) {
    const at = next;
    next = i + 1 < count
      ? start + unsigned("entity offset", lanes[start + STATE_HEADER + i + 1])
      : start + resourcesOffset;
    if (next < at + 3 || next > lanes.length) {
      throw new PacketError(`entity ${i} has an invalid record range`);
    }
    if (lazy) entities[i] = new PackedEntity(schema, lanes, at, next);
    else {
      const id = unsigned("entity id", lanes[at]);
      const parent = unsigned("entity parent", lanes[at + 1]);
      const nameId = unsigned("entity name id", lanes[at + 2]);
      entities[i] = {
        id,
        parent,
        ...(nameId ? { nameId } : {}),
        components: readComponents(schema, lanes, at, next),
      };
    }
  }
  let p = start + resourcesOffset;
  const resources: Record<string, RecordValue> = {};
  for (const resource of schema.resources) {
    const plan = recordPlan(resource);
    if (p + (plan.lanes ?? 0) > lanes.length) {
      throw new PacketError("packet ended early");
    }
    resources[resource.name] = plan.read(lanes, p) as RecordValue;
    p = plan.lanes === null ? cursor : p + plan.lanes;
  }
  return { tick, nextEntity, seed, entities, resources };
}

/** The layout hash a state packet was written with. */
export function packetHash(lanes: Float32Array): number {
  return lanes[0];
}

// Input -----------------------------------------------------------------------

export interface ButtonState {
  down: boolean;
  pressed: boolean;
  released: boolean;
}

export type ActionValue = ButtonState | number | Vec2;

export interface PointerModel {
  /** Normalized device coordinates in the viewport, -1..1, y up. */
  position: Vec2;
  /** Movement since the last step, in CSS pixels. */
  delta: Vec2;
  wheel: number;
  /** World-space ray through the pointer from the active game camera. */
  ray: { origin: Vec3; direction: Vec3 };
  /** Entity under the pointer, 0 if none. */
  hovered: number;
  /** World position under the pointer when `hovered` is set. */
  point: Vec3;
  inside: boolean;
  locked: boolean;
}

export interface InputModel {
  tick: number;
  dt: number;
  time: number;
  viewport: Vec2;
  pointer: PointerModel;
  actions: Record<string, ActionValue>;
  /** Canonical, id-sorted inputs from every player in a network game. */
  players?: PlayerInputModel[];
}

export interface PlayerInputModel {
  id: number;
  viewport: Vec2;
  pointer: PointerModel;
  actions: Record<string, ActionValue>;
}

export function idleInput(schema: Schema, tick = 0, dt = 1 / 60): InputModel {
  return {
    tick,
    dt,
    time: tick * dt,
    viewport: [1280, 720],
    pointer: {
      position: [0, 0],
      delta: [0, 0],
      wheel: 0,
      ray: { origin: [0, 0, 0], direction: [0, 0, -1] },
      hovered: 0,
      point: [0, 0, 0],
      inside: false,
      locked: false,
    },
    actions: Object.fromEntries(
      schema.actions.map((a) => [
        a.name,
        a.action.kind === "button"
          ? { down: false, pressed: false, released: false }
          : a.action.kind === "axis"
          ? 0
          : [0, 0],
      ]),
    ),
  };
}

export function inputLanes(schema: Schema, players = 0): number {
  const single = INPUT_HEADER + schema.actions.reduce((n, a) => n + a.lanes, 0);
  return single + 1 + players * (single - 2);
}

function encodeSingleInput(schema: Schema, input: InputModel): Float32Array {
  const lanes = new Float32Array(inputLanes(schema) - 1);
  const p = input.pointer;
  lanes.set([
    input.tick,
    input.dt,
    input.time,
    input.viewport[0],
    input.viewport[1],
    p.position[0],
    p.position[1],
    p.delta[0],
    p.delta[1],
    p.wheel,
    ...p.ray.origin,
    ...p.ray.direction,
    p.hovered,
    ...p.point,
    p.inside ? 1 : 0,
    p.locked ? 1 : 0,
  ]);
  let offset = INPUT_HEADER;
  for (const action of schema.actions) {
    const value = input.actions[action.name];
    if (action.action.kind === "button") {
      const b = (value ?? {}) as ButtonState;
      lanes[offset] = b.down ? 1 : 0;
      lanes[offset + 1] = b.pressed ? 1 : 0;
      lanes[offset + 2] = b.released ? 1 : 0;
    } else if (action.action.kind === "axis") {
      lanes[offset] = (value as number) ?? 0;
    } else {
      const v = (value ?? [0, 0]) as Vec2;
      lanes[offset] = v[0];
      lanes[offset + 1] = v[1];
    }
    offset += action.lanes;
  }
  return lanes;
}

function decodeSingleInput(schema: Schema, lanes: Float32Array): InputModel {
  const at = (i: number) => lanes[i];
  const actions: Record<string, ActionValue> = {};
  let offset = INPUT_HEADER;
  for (const action of schema.actions) {
    if (action.action.kind === "button") {
      actions[action.name] = {
        down: at(offset) !== 0,
        pressed: at(offset + 1) !== 0,
        released: at(offset + 2) !== 0,
      };
    } else if (action.action.kind === "axis") {
      actions[action.name] = at(offset);
    } else {
      actions[action.name] = [at(offset), at(offset + 1)];
    }
    offset += action.lanes;
  }
  return {
    tick: at(0),
    dt: at(1),
    time: at(2),
    viewport: [at(3), at(4)],
    pointer: {
      position: [at(5), at(6)],
      delta: [at(7), at(8)],
      wheel: at(9),
      ray: {
        origin: [at(10), at(11), at(12)],
        direction: [at(13), at(14), at(15)],
      },
      hovered: at(16),
      point: [at(17), at(18), at(19)],
      inside: at(20) !== 0,
      locked: at(21) !== 0,
    },
    actions,
  };
}

export function encodeInput(schema: Schema, input: InputModel): Float32Array {
  const players = input.players ?? [];
  if (players.length > 16) throw new PacketError("at most 16 player inputs");
  const single = encodeSingleInput(schema, input);
  const lanes = new Float32Array(inputLanes(schema, players.length));
  lanes.set(single);
  lanes[single.length] = players.length;
  let offset = single.length + 1;
  let previous = -1;
  for (const player of players) {
    if (
      !Number.isInteger(player.id) || player.id <= previous ||
      player.id > MAX_EXACT
    ) throw new PacketError("player ids must be unique, ascending integers");
    previous = player.id;
    lanes[offset++] = player.id;
    lanes.set(
      encodeSingleInput(schema, { ...input, ...player }).subarray(3),
      offset,
    );
    offset += single.length - 3;
  }
  if (!lanes.every(Number.isFinite)) {
    throw new PacketError("input must be finite");
  }
  return lanes;
}

export function decodeInput(schema: Schema, lanes: Float32Array): InputModel {
  const single = inputLanes(schema) - 1;
  const count = lanes[single];
  if (
    !Number.isInteger(count) || count < 0 || count > 16 ||
    lanes.length !== inputLanes(schema, count) || !lanes.every(Number.isFinite)
  ) throw new PacketError("invalid input packet");
  const input = decodeSingleInput(schema, lanes);
  let offset = single + 1;
  let previous = -1;
  for (let i = 0; i < count; i++) {
    const id = lanes[offset++];
    if (!Number.isInteger(id) || id <= previous || id > MAX_EXACT) {
      throw new PacketError("player ids must be unique, ascending integers");
    }
    previous = id;
    const row = new Float32Array(single);
    row.set(lanes.subarray(offset, offset + single - 3), 3);
    const { viewport, pointer, actions } = decodeSingleInput(schema, row);
    (input.players ??= []).push({ id, viewport, pointer, actions });
    offset += single - 3;
  }
  return input;
}

// Steps -----------------------------------------------------------------------

export function stepPacket(
  input: Float32Array,
  state: Float32Array,
): Float32Array {
  const packet = new Float32Array(1 + input.length + state.length);
  packet[0] = input.length;
  packet.set(input, 1);
  packet.set(state, 1 + input.length);
  return packet;
}

export interface EventModel {
  name: string;
  value: RecordValue;
}

export interface StepResult {
  state: Float32Array;
  events: EventModel[];
}

export function decodeStepResult(
  schema: Schema,
  lanes: Float32Array,
): StepResult {
  const stateLanes = lanes[0];
  if (!Number.isInteger(stateLanes) || stateLanes + 2 > lanes.length) {
    throw new PacketError(`invalid step result header ${stateLanes}`);
  }
  const state = lanes.subarray(1, 1 + stateLanes);
  return { state, events: decodeEvents(schema, lanes, 1 + stateLanes) };
}

/** Events as written by the guest: a count, then each event's index and lanes. */
export function decodeEvents(
  schema: Schema,
  lanes: Float32Array,
  start = 0,
): EventModel[] {
  if (start >= lanes.length) throw new PacketError("packet ended early");
  const count = unsigned("event count", lanes[start]);
  const events: EventModel[] = [];
  let p = start + 1;
  for (let i = 0; i < count; i++) {
    const index = unsigned("event kind", lanes[p++]);
    const record = schema.events[index];
    if (!record) throw new PacketError(`unknown event kind ${index}`);
    const plan = recordPlan(record, "event ");
    if (p + (plan.lanes ?? 0) > lanes.length) {
      throw new PacketError("packet ended early");
    }
    events.push({
      name: record.name,
      value: plan.read(lanes, p) as RecordValue,
    });
    p = plan.lanes === null ? cursor : p + plan.lanes;
  }
  return events;
}

/** Event encoding, for tests and host-side tools. */
export function encodeEvents(
  schema: Schema,
  events: EventModel[],
): Float32Array {
  let size = 1;
  const plans = events.map((event) => {
    const record = schema.event(event.name);
    if (!record) throw new PacketError(`unknown event ${event.name}`);
    const plan = recordPlan(record, "event ");
    size += 1 + (plan.lanes ?? plan.size(event.value));
    return { record, plan };
  });
  const lanes = new Float32Array(size);
  lanes[0] = integer("event count", events.length);
  let p = 1;
  events.forEach((event, i) => {
    lanes[p++] = plans[i].record.index;
    p = plans[i].plan.write(lanes, p, event.value);
  });
  return lanes;
}

// Small vector helpers used by codec consumers ---------------------------------

export const isVec3 = (value: Value): value is Vec3 =>
  Array.isArray(value) && value.length === 3;
export const isVec4 = (value: Value): value is Vec4 =>
  Array.isArray(value) && value.length === 4;
