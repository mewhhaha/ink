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
 *   entity records     id, parent, then per component in schema order:
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
import type { Node, RecordSchema, Schema } from "./schema.ts";

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

// Sizes -----------------------------------------------------------------------

function valueLanes(node: Node, value: Value): number {
  if (node.lanes !== null) return node.lanes;
  if (node.kind === "list") {
    return 1 + (value as Value[]).length * node.element.lanes;
  }
  if (node.kind === "struct") {
    const record = value as RecordValue;
    return node.fields.reduce(
      (total, f) => total + valueLanes(f.node, record[f.name]),
      0,
    );
  }
  throw new PacketError(`no size for ${(node as Node).kind}`);
}

function recordLanes(record: RecordSchema, value: RecordValue): number {
  if (record.lanes !== null) return record.lanes;
  return record.fields.reduce(
    (total, f) => total + valueLanes(f.node, value[f.name]),
    0,
  );
}

// Writing ---------------------------------------------------------------------

class Writer {
  offset = 0;
  constructor(readonly lanes: Float32Array) {}
  number(value: number) {
    this.lanes[this.offset++] = value;
  }
  integer(value: number, what: string) {
    if (!Number.isInteger(value) || value < 0 || value > MAX_EXACT) {
      throw new PacketError(
        `${what} must be an integer from 0 to ${MAX_EXACT}, got ${value}`,
      );
    }
    this.lanes[this.offset++] = value;
  }
}

function writeValue(w: Writer, node: Node, value: Value, path: string) {
  switch (node.kind) {
    case "f32":
      w.number(value as number);
      return;
    case "u32":
    case "entity":
    case "asset":
    case "message":
      w.integer(value as number, path);
      return;
    case "bool":
      w.number(value ? 1 : 0);
      return;
    case "vec2":
    case "vec3":
    case "vec4":
    case "quat":
    case "color": {
      const vector = value as number[];
      for (let i = 0; i < node.lanes; i++) w.number(vector[i]);
      return;
    }
    case "enum": {
      const index = node.values.indexOf(value as string);
      if (index < 0) {
        throw new PacketError(
          `${path}: "${value}" is not one of ${node.values}`,
        );
      }
      w.number(index);
      return;
    }
    case "struct": {
      const record = value as RecordValue;
      for (const f of node.fields) {
        writeValue(w, f.node, record[f.name], `${path}.${f.name}`);
      }
      return;
    }
    case "list": {
      const items = value as Value[];
      w.integer(items.length, `${path} length`);
      items.forEach((item, i) =>
        writeValue(w, node.element, item, `${path}[${i}]`)
      );
      return;
    }
  }
}

function writeRecord(
  w: Writer,
  record: RecordSchema,
  value: RecordValue,
  path: string,
) {
  for (const f of record.fields) {
    writeValue(w, f.node, value[f.name], `${path}.${f.name}`);
  }
}

export function encodeWorld(schema: Schema, world: WorldModel): Float32Array {
  const count = world.entities.length;
  let size = STATE_HEADER + count;
  const entityStarts: number[] = [];
  for (const entity of world.entities) {
    entityStarts.push(size);
    size += 2;
    for (const component of schema.components) {
      const value = entity.components[component.name];
      size += 1 + (value ? recordLanes(component, value) : 0);
    }
  }
  const resourcesOffset = size;
  for (const resource of schema.resources) {
    size += recordLanes(resource, world.resources[resource.name]);
  }
  const w = new Writer(new Float32Array(size));
  const seed = world.seed >>> 0;
  w.number(schema.hash);
  w.integer(world.tick, "tick");
  w.integer(world.nextEntity, "next entity id");
  w.number(seed >>> 16);
  w.number(seed & 0xffff);
  w.integer(count, "entity count");
  w.integer(resourcesOffset, "resources offset");
  for (const start of entityStarts) w.integer(start, "entity offset");
  for (const entity of world.entities) {
    w.integer(entity.id, "entity id");
    w.integer(entity.parent, `entity ${entity.id} parent`);
    for (const component of schema.components) {
      const value = entity.components[component.name];
      if (value) {
        w.number(1);
        writeRecord(
          w,
          component,
          value,
          `entity ${entity.id} ${component.name}`,
        );
      } else {
        w.number(0);
      }
    }
  }
  for (const resource of schema.resources) {
    writeRecord(
      w,
      resource,
      world.resources[resource.name],
      `resource ${resource.name}`,
    );
  }
  return w.lanes;
}

// Reading ---------------------------------------------------------------------

class Reader {
  constructor(readonly lanes: Float32Array, public offset: number) {}
  number(): number {
    if (this.offset >= this.lanes.length) {
      throw new PacketError("packet ended early");
    }
    return this.lanes[this.offset++];
  }
  integer(what: string): number {
    const value = this.number();
    if (!Number.isInteger(value) || value < 0) {
      throw new PacketError(`${what} is not an integer: ${value}`);
    }
    return value;
  }
}

function readValue(r: Reader, node: Node, path: string): Value {
  switch (node.kind) {
    case "f32":
      return r.number();
    case "u32":
    case "entity":
    case "asset":
    case "message":
      return r.integer(path);
    case "bool":
      return r.number() !== 0;
    case "vec2":
    case "vec3":
    case "vec4":
    case "quat":
    case "color": {
      const vector: number[] = [];
      for (let i = 0; i < node.lanes; i++) vector.push(r.number());
      return vector;
    }
    case "enum": {
      const index = r.integer(path);
      return node.values[index] ?? node.values[0];
    }
    case "struct":
      return Object.fromEntries(
        node.fields.map((
          f,
        ) => [f.name, readValue(r, f.node, `${path}.${f.name}`)]),
      );
    case "list": {
      const length = r.integer(`${path} length`);
      const items: Value[] = [];
      for (let i = 0; i < length; i++) {
        items.push(readValue(r, node.element, `${path}[${i}]`));
      }
      return items;
    }
  }
}

function readRecord(
  r: Reader,
  record: RecordSchema,
  path: string,
): RecordValue {
  return Object.fromEntries(
    record.fields.map((
      f,
    ) => [f.name, readValue(r, f.node, `${path}.${f.name}`)]),
  );
}

/** Decode a state packet. `start` is where the state begins in `lanes`. */
export function decodeWorld(
  schema: Schema,
  lanes: Float32Array,
  start = 0,
): WorldModel {
  const r = new Reader(lanes, start);
  const hash = r.number();
  if (hash !== schema.hash) {
    throw new PacketError(
      `state was written by schema ${hash}, expected ${schema.hash}`,
    );
  }
  const tick = r.integer("tick");
  const nextEntity = r.integer("next entity id");
  const seed = ((r.integer("seed") << 16) | r.integer("seed")) >>> 0;
  const count = r.integer("entity count");
  const resourcesOffset = r.integer("resources offset");
  const entities: EntityModel[] = [];
  for (let i = 0; i < count; i++) {
    const record = new Reader(lanes, start + lanes[start + STATE_HEADER + i]);
    const id = record.integer("entity id");
    const parent = record.integer("parent");
    const components: Record<string, RecordValue> = {};
    for (const component of schema.components) {
      if (record.number() !== 0) {
        components[component.name] = readRecord(
          record,
          component,
          `entity ${id} ${component.name}`,
        );
      }
    }
    entities.push({ id, parent, components });
  }
  const resourceReader = new Reader(lanes, start + resourcesOffset);
  const resources: Record<string, RecordValue> = {};
  for (const resource of schema.resources) {
    resources[resource.name] = readRecord(
      resourceReader,
      resource,
      `resource ${resource.name}`,
    );
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

export function inputLanes(schema: Schema): number {
  return INPUT_HEADER + schema.actions.reduce((n, a) => n + a.lanes, 0);
}

export function encodeInput(schema: Schema, input: InputModel): Float32Array {
  const lanes = new Float32Array(inputLanes(schema));
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

export function decodeInput(schema: Schema, lanes: Float32Array): InputModel {
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
  const state = lanes.slice(1, 1 + stateLanes);
  return { state, events: decodeEvents(schema, lanes, 1 + stateLanes) };
}

/** Events as written by the guest: a count, then each event's index and lanes. */
export function decodeEvents(
  schema: Schema,
  lanes: Float32Array,
  start = 0,
): EventModel[] {
  const r = new Reader(lanes, start);
  const count = r.integer("event count");
  const events: EventModel[] = [];
  for (let i = 0; i < count; i++) {
    const index = r.integer("event kind");
    const record = schema.events[index];
    if (!record) throw new PacketError(`unknown event kind ${index}`);
    events.push({
      name: record.name,
      value: readRecord(r, record, record.name),
    });
  }
  return events;
}

/** Event encoding, for tests and host-side tools. */
export function encodeEvents(
  schema: Schema,
  events: EventModel[],
): Float32Array {
  let size = 1;
  for (const event of events) {
    const record = schema.event(event.name);
    if (!record) throw new PacketError(`unknown event ${event.name}`);
    size += 1 + recordLanes(record, event.value);
  }
  const w = new Writer(new Float32Array(size));
  w.integer(events.length, "event count");
  for (const event of events) {
    const record = schema.event(event.name)!;
    w.integer(record.index, "event kind");
    writeRecord(w, record, event.value, event.name);
  }
  return w.lanes;
}

// Small vector helpers used by codec consumers ---------------------------------

export const isVec3 = (value: Value): value is Vec3 =>
  Array.isArray(value) && value.length === 3;
export const isVec4 = (value: Value): value is Vec4 =>
  Array.isArray(value) && value.length === 4;
