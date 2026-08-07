import type { Observer } from "@ink/observability/observer.ts";

export type ChannelGuarantee =
  | "reliable_ordered"
  | "reliable_unordered"
  | "unreliable";
export interface TransportCapabilities {
  readonly guarantees: readonly ChannelGuarantee[];
  readonly maximum_message_bytes: number;
}
export interface Transport {
  readonly capabilities: TransportCapabilities;
  send(channel: number, payload: Uint8Array): void;
  close(reason: string): void;
}
export interface TransportSink {
  send(bytes: Uint8Array): void;
  close(reason: string): void;
}
export function websocket_transport(
  sink: TransportSink,
  maximum_message_bytes = 64 * 1024,
): Transport {
  const parsed_maximum_message_bytes = parse_positive_safe_integer(
    maximum_message_bytes,
    "WebSocket maximum message bytes",
  );
  return Object.freeze({
    capabilities: Object.freeze({
      guarantees: Object.freeze(["reliable_ordered"] as ChannelGuarantee[]),
      maximum_message_bytes: parsed_maximum_message_bytes,
    }),
    send: (channel: number, payload: Uint8Array) => {
      parse_uint(channel, "WebSocket channel", 0xffff);
      if (payload.length > parsed_maximum_message_bytes) {
        throw new Error(
          `WebSocket payload length ${payload.length} exceeds ${parsed_maximum_message_bytes}`,
        );
      }
      sink.send(payload.slice());
    },
    close: (reason: string) => sink.close(reason),
  });
}
export function webtransport_transport(
  reliable: TransportSink,
  datagrams: TransportSink | null,
  maximum_message_bytes = 64 * 1024,
): Transport {
  const parsed_maximum_message_bytes = parse_positive_safe_integer(
    maximum_message_bytes,
    "WebTransport maximum message bytes",
  );
  const guarantees: ChannelGuarantee[] = datagrams === null
    ? ["reliable_ordered", "reliable_unordered"]
    : ["reliable_ordered", "reliable_unordered", "unreliable"];
  return Object.freeze({
    capabilities: Object.freeze({
      guarantees: Object.freeze(guarantees),
      maximum_message_bytes: parsed_maximum_message_bytes,
    }),
    send: (channel: number, payload: Uint8Array) => {
      parse_uint(channel, "WebTransport channel", 0xffff);
      if (payload.length > parsed_maximum_message_bytes) {
        throw new Error(
          `WebTransport payload length ${payload.length} exceeds ${parsed_maximum_message_bytes}`,
        );
      }
      (channel === 2 && datagrams !== null ? datagrams : reliable).send(
        payload.slice(),
      );
    },
    close: (reason: string) => {
      reliable.close(reason);
      if (datagrams !== null && datagrams !== reliable) {
        datagrams.close(reason);
      }
    },
  });
}
export interface Handshake {
  readonly protocol: number;
  readonly engine: string;
  readonly game: string;
  readonly schema: string;
  readonly features: readonly string[];
  readonly content: string;
}
export type Compatibility = { readonly type: "compatible" } | {
  readonly type: "rejected";
  readonly reason:
    | "protocol"
    | "engine"
    | "game"
    | "schema"
    | "features"
    | "content";
  readonly expected: string;
  readonly received: string;
};
export function handshake_compatibility(
  expected: Handshake,
  received: Handshake,
): Compatibility {
  for (
    const field of ["protocol", "engine", "game", "schema", "content"] as const
  ) {
    if (expected[field] !== received[field]) {
      return {
        type: "rejected",
        reason: field,
        expected: String(expected[field]),
        received: String(received[field]),
      };
    }
  }
  const expected_features = [...expected.features].sort();
  const received_features = [...received.features].sort();
  if (expected_features.join("\n") !== received_features.join("\n")) {
    return {
      type: "rejected",
      reason: "features",
      expected: JSON.stringify(expected_features),
      received: JSON.stringify(received_features),
    };
  }
  return { type: "compatible" };
}
export function sequence_newer(first: number, second: number): boolean {
  const parsed_first = parse_uint(first, "first sequence", 0xffff_ffff);
  const parsed_second = parse_uint(second, "second sequence", 0xffff_ffff);
  return parsed_first !== parsed_second &&
    ((parsed_first - parsed_second) >>> 0) < 0x8000_0000;
}

export interface Packet {
  readonly sequence: number;
  readonly acknowledgement: number;
  readonly channel: number;
  readonly kind: string;
  readonly payload: PacketValue;
}
export type PacketValue =
  | null
  | boolean
  | number
  | string
  | readonly PacketValue[]
  | { readonly [key: string]: PacketValue };
export type PacketParse =
  | { readonly type: "ready"; readonly packet: Packet }
  | { readonly type: "rejected"; readonly reason: string };
const encoder = new TextEncoder();
export function encode_packet(
  packet: Packet,
  maximum_bytes = 64 * 1024,
): Uint8Array {
  const parsed_maximum_bytes = parse_positive_safe_integer(
    maximum_bytes,
    "maximum packet bytes",
  );
  parse_uint(packet.sequence, "sequence", 0xffff_ffff);
  parse_uint(packet.acknowledgement, "acknowledgement", 0xffff_ffff);
  parse_uint(packet.channel, "channel", 0xffff);
  parse_nonempty_string(packet.kind, "packet kind");
  parse_packet_value(packet.payload, "packet payload");
  let source: string;
  try {
    source = JSON.stringify(packet);
  } catch (cause) {
    throw new Error("packet is not JSON-serializable", { cause });
  }
  const bytes = encoder.encode(source);
  if (bytes.length > parsed_maximum_bytes) {
    throw new Error(
      `packet length ${bytes.length} exceeds ${parsed_maximum_bytes}`,
    );
  }
  return bytes;
}
export function parse_packet(
  bytes: Uint8Array,
  maximum_bytes = 64 * 1024,
): PacketParse {
  let parsed_maximum_bytes: number;
  try {
    parsed_maximum_bytes = parse_positive_safe_integer(
      maximum_bytes,
      "maximum packet bytes",
    );
  } catch (error) {
    return { type: "rejected", reason: error_reason(error) };
  }
  if (bytes.length > parsed_maximum_bytes) {
    return {
      type: "rejected",
      reason: `packet length ${bytes.length} exceeds ${parsed_maximum_bytes}`,
    };
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { type: "rejected", reason: "packet is not valid UTF-8" };
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return { type: "rejected", reason: "packet is not valid JSON" };
  }
  if (!record(value)) {
    return { type: "rejected", reason: "packet must be an object" };
  }
  const fields = Object.keys(value).sort();
  const expected_fields = [
    "acknowledgement",
    "channel",
    "kind",
    "payload",
    "sequence",
  ];
  if (fields.join("\n") !== expected_fields.join("\n")) {
    return {
      type: "rejected",
      reason: `packet fields are ${JSON.stringify(fields)}`,
    };
  }
  if (
    !uint(value.sequence, 0xffff_ffff) ||
    !uint(value.acknowledgement, 0xffff_ffff) ||
    !uint(value.channel, 0xffff) || typeof value.kind !== "string" ||
    value.kind.length === 0
  ) {
    return { type: "rejected", reason: "packet fields are malformed" };
  }
  return { type: "ready", packet: value as unknown as Packet };
}

export interface Fragment {
  readonly message: number;
  readonly index: number;
  readonly count: number;
  readonly bytes: Uint8Array;
}
export function fragment_message(
  message: number,
  bytes: Uint8Array,
  size: number,
): readonly Fragment[] {
  parse_uint(message, "message", 0xffff_ffff);
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new Error(`fragment size ${size} must be positive`);
  }
  const count = Math.max(1, Math.ceil(bytes.length / size));
  if (count > 0xffff) {
    throw new Error(
      `message ${message} requires ${count} fragments, exceeding 65535`,
    );
  }
  return Object.freeze(
    Array.from({ length: count }, (_, index) =>
      Object.freeze({
        message,
        index,
        count,
        bytes: bytes.slice(index * size, (index + 1) * size),
      })),
  );
}
export class Reassembler {
  readonly #maximum_messages: number;
  readonly #maximum_message_bytes: number;
  readonly #messages = new Map<
    number,
    { count: number; parts: Map<number, Uint8Array>; received_bytes: number }
  >();
  constructor(maximum_messages = 64, maximum_message_bytes = 64 * 1024) {
    this.#maximum_messages = parse_positive_safe_integer(
      maximum_messages,
      "maximum reassembly messages",
    );
    this.#maximum_message_bytes = parse_positive_safe_integer(
      maximum_message_bytes,
      "maximum reassembled message bytes",
    );
  }
  push(fragment: Fragment): Uint8Array | null {
    if (
      !uint(fragment.message, 0xffff_ffff) ||
      !uint(fragment.index, 0xffff) || !uint(fragment.count, 0xffff) ||
      fragment.count === 0 || fragment.index >= fragment.count
    ) {
      throw new Error(
        `fragment ${fragment.message}:${fragment.index}/${fragment.count} is invalid`,
      );
    }
    if (fragment.bytes.length > this.#maximum_message_bytes) {
      throw new Error(
        `fragment ${fragment.message}:${fragment.index} length ${fragment.bytes.length} exceeds message limit ${this.#maximum_message_bytes}`,
      );
    }
    let assembly = this.#messages.get(fragment.message);
    if (assembly === undefined) {
      if (this.#messages.size >= this.#maximum_messages) {
        throw new Error(
          `reassembly queue reached ${this.#maximum_messages} messages`,
        );
      }
      assembly = { count: fragment.count, parts: new Map(), received_bytes: 0 };
      this.#messages.set(fragment.message, assembly);
    } else if (assembly.count !== fragment.count) {
      throw new Error(
        `message ${fragment.message} fragment count changed from ${assembly.count} to ${fragment.count}`,
      );
    }
    const previous = assembly.parts.get(fragment.index);
    if (previous !== undefined) {
      if (!bytes_equal(previous, fragment.bytes)) {
        throw new Error(
          `message ${fragment.message} fragment ${fragment.index} conflicts with the received bytes`,
        );
      }
      return null;
    }
    const received_bytes = assembly.received_bytes + fragment.bytes.length;
    if (received_bytes > this.#maximum_message_bytes) {
      this.#messages.delete(fragment.message);
      throw new Error(
        `message ${fragment.message} length exceeds ${this.#maximum_message_bytes} bytes`,
      );
    }
    assembly.parts.set(fragment.index, fragment.bytes.slice());
    assembly.received_bytes = received_bytes;
    if (assembly.parts.size !== assembly.count) return null;
    const joined = new Uint8Array(assembly.received_bytes);
    let offset = 0;
    for (let i = 0; i < assembly.count; i++) {
      const part = assembly.parts.get(i);
      if (part === undefined) return null;
      joined.set(part, offset);
      offset += part.length;
    }
    this.#messages.delete(fragment.message);
    return joined;
  }
}

export class ReliableQueue {
  readonly #limit: number;
  readonly #pending = new Map<
    number,
    { bytes: Uint8Array; sent_at: number }
  >();
  constructor(limit = 256) {
    this.#limit = parse_positive_safe_integer(limit, "reliable queue limit");
  }
  enqueue(sequence: number, bytes: Uint8Array, now: number): void {
    const parsed_sequence = parse_uint(
      sequence,
      "reliable sequence",
      0xffff_ffff,
    );
    parse_finite_nonnegative(now, "reliable enqueue time");
    if (this.#pending.has(parsed_sequence)) {
      throw new Error(
        `reliable sequence ${parsed_sequence} is already pending`,
      );
    }
    if (this.#pending.size >= this.#limit) {
      throw new Error(`reliable queue reached ${this.#limit} packets`);
    }
    this.#pending.set(parsed_sequence, {
      bytes: bytes.slice(),
      sent_at: now,
    });
  }
  acknowledge(sequence: number): void {
    this.#pending.delete(
      parse_uint(sequence, "acknowledged sequence", 0xffff_ffff),
    );
  }
  retransmissions(now: number, timeout: number): readonly Uint8Array[] {
    parse_finite_nonnegative(now, "retransmission time");
    parse_finite_nonnegative(timeout, "retransmission timeout");
    for (const [sequence, pending] of this.#pending) {
      if (now < pending.sent_at) {
        throw new Error(
          `retransmission time ${now} precedes sequence ${sequence} send time ${pending.sent_at}`,
        );
      }
    }
    const result: Uint8Array[] = [];
    for (const pending of this.#pending.values()) {
      if (now - pending.sent_at >= timeout) {
        pending.sent_at = now;
        result.push(pending.bytes.slice());
      }
    }
    return result;
  }
  get size(): number {
    return this.#pending.size;
  }
}

export type FieldKind = "number" | "boolean" | "string";
export interface ReplicatedField {
  readonly name: string;
  readonly kind: FieldKind;
  readonly quantum?: number;
  readonly authority: "server" | "owner";
  readonly frequency: number;
}
declare const replication_schema_brand: unique symbol;
export interface ReplicationSchema {
  readonly id: string;
  readonly fields: readonly ReplicatedField[];
  readonly [replication_schema_brand]: true;
}
export function define_replication_schema(
  id: string,
  fields: readonly ReplicatedField[],
): ReplicationSchema {
  parse_nonempty_string(id, "replication schema id");
  if (fields.length === 0) {
    throw new Error(`replication schema ${JSON.stringify(id)} has no fields`);
  }
  const names = new Set<string>();
  const parsed_fields = fields.map((field, index) => {
    parse_nonempty_string(field.name, `replication field ${index} name`);
    if (names.has(field.name)) {
      throw new Error(
        `replication schema ${JSON.stringify(id)} repeats field ${
          JSON.stringify(field.name)
        }`,
      );
    }
    names.add(field.name);
    if (
      field.kind !== "number" && field.kind !== "boolean" &&
      field.kind !== "string"
    ) {
      throw new Error(
        `replication field ${JSON.stringify(field.name)} kind ${
          JSON.stringify(field.kind)
        } is unsupported`,
      );
    }
    if (field.authority !== "server" && field.authority !== "owner") {
      throw new Error(
        `replication field ${JSON.stringify(field.name)} authority ${
          JSON.stringify(field.authority)
        } is unsupported`,
      );
    }
    const frequency = parse_positive_safe_integer(
      field.frequency,
      `replication field ${JSON.stringify(field.name)} frequency`,
    );
    if (field.quantum !== undefined && field.kind !== "number") {
      throw new Error(
        `replication field ${
          JSON.stringify(field.name)
        } can only quantize numbers`,
      );
    }
    const quantum = field.quantum === undefined
      ? undefined
      : parse_finite_positive(
        field.quantum,
        `replication field ${JSON.stringify(field.name)} quantum`,
      );
    return Object.freeze({
      name: field.name,
      kind: field.kind,
      authority: field.authority,
      frequency,
      ...(quantum === undefined ? {} : { quantum }),
    });
  });
  return Object.freeze({
    id,
    fields: Object.freeze(parsed_fields),
  }) as ReplicationSchema;
}
export interface NetworkEntity {
  readonly id: number;
  readonly generation: number;
}
export interface EntityState {
  readonly identity: NetworkEntity;
  readonly values: Readonly<Record<string, number | boolean | string>>;
  readonly relevance?: readonly string[];
}
export interface Snapshot {
  readonly schema: string;
  readonly tick: number;
  readonly baseline: number | null;
  readonly entities: readonly EntityState[];
}
export function build_snapshot(
  tick: number,
  schema: ReplicationSchema,
  states: readonly EntityState[],
  baseline: Snapshot | null,
  interests: ReadonlySet<string>,
  byte_budget: number,
): Snapshot {
  const parsed_tick = parse_uint(tick, "snapshot tick", 0xffff_ffff);
  const parsed_byte_budget = parse_nonnegative_safe_integer(
    byte_budget,
    "snapshot byte budget",
  );
  if (baseline !== null && baseline.schema !== schema.id) {
    throw new Error(
      `snapshot baseline schema ${
        JSON.stringify(baseline.schema)
      } does not match ${JSON.stringify(schema.id)}`,
    );
  }
  if (baseline !== null && baseline.tick >= parsed_tick) {
    throw new Error(
      `snapshot baseline tick ${baseline.tick} must precede tick ${parsed_tick}`,
    );
  }
  const previous = new Map(
    (baseline?.entities ?? []).map((
      state,
    ) => [`${state.identity.id}:${state.identity.generation}`, state]),
  );
  const entities: EntityState[] = [];
  const identities = new Set<string>();
  let used = 0;
  for (
    const state of [...states].sort((a, b) =>
      a.identity.id - b.identity.id ||
      a.identity.generation - b.identity.generation
    )
  ) {
    const id = parse_uint(state.identity.id, "network entity id", 0xffff_ffff);
    const generation = parse_uint(
      state.identity.generation,
      `network entity ${id} generation`,
      0xffff_ffff,
    );
    const identity_key = `${id}:${generation}`;
    if (identities.has(identity_key)) {
      throw new Error(`snapshot repeats network entity ${identity_key}`);
    }
    identities.add(identity_key);
    if (
      state.relevance !== undefined &&
      !state.relevance.some((key) => interests.has(key))
    ) continue;
    const values: Record<string, number | boolean | string> = {};
    for (const field of schema.fields) {
      const source = state.values[field.name];
      const matches_kind = field.kind === "number"
        ? typeof source === "number"
        : field.kind === "boolean"
        ? typeof source === "boolean"
        : typeof source === "string";
      if (!matches_kind) {
        throw new Error(
          `schema ${schema.id} entity ${identity_key} field ${field.name} expected ${field.kind}, received ${
            JSON.stringify(source)
          }`,
        );
      }
      if (typeof source === "number" && !Number.isFinite(source)) {
        throw new Error(
          `schema ${schema.id} entity ${identity_key} field ${field.name} must be finite, received ${
            String(source)
          }`,
        );
      }
      if (parsed_tick % field.frequency !== 0) continue;
      const replicated = typeof source === "number" &&
          field.quantum !== undefined
        ? Math.round(source / field.quantum) * field.quantum
        : source;
      if (typeof replicated === "number" && !Number.isFinite(replicated)) {
        throw new Error(
          `schema ${schema.id} entity ${identity_key} field ${field.name} quantized to ${
            String(replicated)
          }`,
        );
      }
      values[field.name] = replicated;
    }
    const old = previous.get(identity_key);
    const changed = old === undefined || Object.entries(values).some(
      ([name, value]) => old.values[name] !== value,
    );
    if (!changed) continue;
    const replicated_state = Object.freeze({
      identity: Object.freeze({ id, generation }),
      values: Object.freeze(values),
      ...(state.relevance === undefined
        ? {}
        : { relevance: Object.freeze([...state.relevance]) }),
    });
    const encoded = encoder.encode(JSON.stringify(replicated_state)).length;
    if (used + encoded > parsed_byte_budget) continue;
    entities.push(replicated_state);
    used += encoded;
  }
  return Object.freeze({
    schema: schema.id,
    tick: parsed_tick,
    baseline: baseline?.tick ?? null,
    entities: Object.freeze(entities),
  });
}

export interface InputCommand {
  readonly tick: number;
  readonly axes: readonly number[];
  readonly buttons: number;
}
export interface TimeSample {
  readonly sent_at: number;
  readonly received_at: number;
  readonly remote_at: number;
}
export function synchronize_time(
  sample: TimeSample,
): { readonly round_trip: number; readonly offset: number } {
  const sent_at = parse_finite_nonnegative(
    sample.sent_at,
    "time sample sent_at",
  );
  const received_at = parse_finite_nonnegative(
    sample.received_at,
    "time sample received_at",
  );
  const remote_at = parse_finite_nonnegative(
    sample.remote_at,
    "time sample remote_at",
  );
  const round_trip = parse_finite_nonnegative(
    received_at - sent_at,
    "time sample round trip",
  );
  const offset = remote_at - (sent_at + round_trip / 2);
  if (!Number.isFinite(offset)) {
    throw new Error(`time sample offset ${String(offset)} must be finite`);
  }
  return Object.freeze({
    round_trip,
    offset,
  });
}
export interface ReplicationPort<State> {
  capture(tick: number): readonly State[];
  apply(snapshot: Snapshot): void;
}
export interface TransformReplication {
  readonly identity: NetworkEntity;
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
}
export interface PhysicsReplication {
  readonly identity: NetworkEntity;
  readonly linear_velocity: readonly [number, number, number];
  readonly angular_velocity: readonly [number, number, number];
}
export interface InputPort {
  commands(from_tick: number): readonly InputCommand[];
  confirm(tick: number): void;
}
export function normalize_input(command: InputCommand): InputCommand {
  return Object.freeze({
    tick: parse_uint(command.tick, "input tick", 0xffff_ffff),
    axes: Object.freeze(command.axes.map((axis, index) => {
      if (!Number.isFinite(axis)) {
        throw new Error(`input axis ${index} must be finite`);
      }
      return Math.max(-1, Math.min(1, axis));
    })),
    buttons: parse_uint(command.buttons, "input buttons", 0xffff_ffff),
  });
}
export function interpolate_samples<T>(
  first: { time: number; value: T },
  second: { time: number; value: T },
  time: number,
  blend: (a: T, b: T, amount: number) => T,
): T {
  parse_finite_nonnegative(first.time, "first interpolation time");
  parse_finite_nonnegative(second.time, "second interpolation time");
  parse_finite_nonnegative(time, "requested interpolation time");
  if (second.time <= first.time) {
    throw new Error(
      `interpolation times ${first.time}/${second.time} are unordered`,
    );
  }
  return blend(
    first.value,
    second.value,
    Math.max(0, Math.min(1, (time - first.time) / (second.time - first.time))),
  );
}
export interface PredictionPort<State> {
  clone(state: State): State;
  step(state: State, input: InputCommand): State;
  error(predicted: State, authoritative: State): number;
  reconcile(predicted: State, authoritative: State, amount: number): State;
}
export function correct_prediction<State>(
  port: PredictionPort<State>,
  confirmed: State,
  authoritative: State,
  pending: readonly InputCommand[],
  threshold: number,
  amount: number,
): { state: State; correction: number } {
  const parsed_threshold = parse_finite_nonnegative(
    threshold,
    "prediction correction threshold",
  );
  const parsed_amount = parse_probability(
    amount,
    "prediction correction amount",
  );
  const correction = parse_finite_nonnegative(
    port.error(confirmed, authoritative),
    "prediction correction",
  );
  let state = correction > parsed_threshold
    ? port.reconcile(confirmed, authoritative, parsed_amount)
    : port.clone(confirmed);
  for (const input of pending) state = port.step(state, input);
  return { state, correction };
}
export interface RollbackPort<State> {
  restore(snapshot: State): void;
  step(input: InputCommand): void;
  checksum(): string;
}
export function rollback<State>(
  port: RollbackPort<State>,
  snapshot: State,
  inputs: readonly InputCommand[],
  expected_checksum: string,
): { readonly type: "reproduced"; readonly checksum: string } | {
  readonly type: "mismatch";
  readonly expected: string;
  readonly received: string;
} {
  port.restore(snapshot);
  for (const input of inputs) port.step(input);
  const received = port.checksum();
  return received === expected_checksum
    ? { type: "reproduced", checksum: received }
    : { type: "mismatch", expected: expected_checksum, received };
}

export interface SimulationOptions {
  readonly seed: number;
  readonly latency: number;
  readonly jitter: number;
  readonly loss: number;
  readonly duplication: number;
  readonly corruption: number;
  readonly bandwidth: number;
  readonly reorder: number;
}
export class NetworkSimulator {
  #random: number;
  readonly #options: SimulationOptions;
  readonly #pending: { at: number; order: number; bytes: Uint8Array }[] = [];
  #order = 0;
  constructor(options: SimulationOptions) {
    this.#options = Object.freeze({
      seed: parse_uint(options.seed, "network simulation seed", 0xffff_ffff),
      latency: parse_finite_nonnegative(
        options.latency,
        "network simulation latency",
      ),
      jitter: parse_finite_nonnegative(
        options.jitter,
        "network simulation jitter",
      ),
      loss: parse_probability(options.loss, "network simulation loss"),
      duplication: parse_probability(
        options.duplication,
        "network simulation duplication",
      ),
      corruption: parse_probability(
        options.corruption,
        "network simulation corruption",
      ),
      bandwidth: parse_finite_positive(
        options.bandwidth,
        "network simulation bandwidth",
      ),
      reorder: parse_probability(
        options.reorder,
        "network simulation reorder",
      ),
    });
    this.#random = this.#options.seed;
  }
  send(now: number, bytes: Uint8Array): void {
    parse_finite_nonnegative(now, "network simulation send time");
    if (this.#next() < this.#options.loss) return;
    const copies = this.#next() < this.#options.duplication ? 2 : 1;
    for (let copy = 0; copy < copies; copy++) {
      const payload = bytes.slice();
      if (payload.length > 0 && this.#next() < this.#options.corruption) {
        payload[Math.floor(this.#next() * payload.length)] ^= 1;
      }
      const jitter = (this.#next() * 2 - 1) * this.#options.jitter;
      const serialization = payload.length /
        Math.max(1, this.#options.bandwidth);
      const reorder = this.#next() < this.#options.reorder
        ? -this.#options.jitter
        : 0;
      this.#pending.push({
        at: now + this.#options.latency + jitter + serialization + reorder,
        order: this.#order++,
        bytes: payload,
      });
    }
  }
  receive(now: number): readonly Uint8Array[] {
    parse_finite_nonnegative(now, "network simulation receive time");
    const ready = this.#pending.filter(({ at }) => at <= now).sort((a, b) =>
      a.at - b.at || a.order - b.order
    );
    for (const packet of ready) {
      this.#pending.splice(this.#pending.indexOf(packet), 1);
    }
    return Object.freeze(ready.map(({ bytes }) => bytes));
  }
  #next(): number {
    this.#random = (Math.imul(this.#random, 1664525) + 1013904223) >>> 0;
    return this.#random / 0x1_0000_0000;
  }
}

export class NetworkSession {
  readonly #transport: Transport;
  readonly #observer?: Observer;
  readonly #guarantees: ReadonlySet<ChannelGuarantee>;
  readonly #maximum_message_bytes: number;
  #last_received = 0;
  #has_received = false;
  constructor(transport: Transport, observer?: Observer) {
    this.#transport = transport;
    this.#observer = observer;
    this.#maximum_message_bytes = parse_positive_safe_integer(
      transport.capabilities.maximum_message_bytes,
      "transport maximum message bytes",
    );
    const guarantees = new Set<ChannelGuarantee>();
    for (const guarantee of transport.capabilities.guarantees) {
      if (
        guarantee !== "reliable_ordered" &&
        guarantee !== "reliable_unordered" && guarantee !== "unreliable"
      ) {
        throw new Error(
          `transport guarantee ${JSON.stringify(guarantee)} is unsupported`,
        );
      }
      if (guarantees.has(guarantee)) {
        throw new Error(
          `transport repeats guarantee ${JSON.stringify(guarantee)}`,
        );
      }
      guarantees.add(guarantee);
    }
    this.#guarantees = guarantees;
  }
  require(guarantee: ChannelGuarantee): void {
    if (!this.#guarantees.has(guarantee)) {
      this.#observer?.diagnostic(
        "error",
        "network.capability",
        `transport lacks ${guarantee}`,
        { guarantee },
      );
      this.#transport.close(`unsupported guarantee ${guarantee}`);
      throw new Error(`transport does not support ${guarantee}`);
    }
  }
  receive(bytes: Uint8Array): PacketParse {
    const parsed = parse_packet(
      bytes,
      this.#maximum_message_bytes,
    );
    if (parsed.type === "rejected") {
      this.#observer?.event("network.packet.rejected", {
        reason: parsed.reason,
      });
    } else if (
      !this.#has_received ||
      sequence_newer(parsed.packet.sequence, this.#last_received)
    ) {
      this.#last_received = parsed.packet.sequence;
      this.#has_received = true;
    }
    return parsed;
  }
  keepalive(sequence: number): void {
    this.#transport.send(
      0,
      encode_packet({
        sequence,
        acknowledgement: this.#last_received,
        channel: 0,
        kind: "keepalive",
        payload: null,
      }, this.#maximum_message_bytes),
    );
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function uint(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 &&
    (value as number) <= maximum;
}
function parse_uint(value: number, label: string, maximum: number): number {
  if (!uint(value, maximum)) {
    throw new Error(`${label} ${value} must be in 0..${maximum}`);
  }
  return value;
}

function parse_positive_safe_integer(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `${label} ${String(value)} must be a positive safe integer`,
    );
  }
  return value;
}

function parse_nonnegative_safe_integer(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `${label} ${String(value)} must be a nonnegative safe integer`,
    );
  }
  return value;
}

function parse_finite_nonnegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `${label} ${String(value)} must be finite and nonnegative`,
    );
  }
  return value;
}

function parse_finite_positive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `${label} ${String(value)} must be finite and positive`,
    );
  }
  return value;
}

function parse_probability(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} ${String(value)} must be in 0..1`);
  }
  return value;
}

function parse_nonempty_string(value: string, label: string): string {
  if (value.length === 0) {
    throw new Error(`${label} cannot be empty`);
  }
  return value;
}

function bytes_equal(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((byte, index) => byte === right[index]);
}

function error_reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parse_packet_value(
  value: unknown,
  path: string,
  depth = 0,
): PacketValue {
  if (depth > 64) {
    throw new Error(`${path} exceeds 64 levels`);
  }
  if (
    value === null || typeof value === "boolean" || typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} number ${String(value)} must be finite`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      parse_packet_value(entry, `${path}[${index}]`, depth + 1)
    );
  }
  if (!record(value)) {
    throw new Error(`${path} has unsupported type ${typeof value}`);
  }
  const parsed: Record<string, PacketValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    parsed[key] = parse_packet_value(
      entry,
      `${path}.${key}`,
      depth + 1,
    );
  }
  return parsed;
}
