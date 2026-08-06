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
  return Object.freeze({
    capabilities: Object.freeze({
      guarantees: Object.freeze(["reliable_ordered"] as ChannelGuarantee[]),
      maximum_message_bytes,
    }),
    send: (_channel: number, payload: Uint8Array) => sink.send(payload),
    close: (reason: string) => sink.close(reason),
  });
}
export function webtransport_transport(
  reliable: TransportSink,
  datagrams: TransportSink | null,
  maximum_message_bytes = 64 * 1024,
): Transport {
  const guarantees: ChannelGuarantee[] = datagrams === null
    ? ["reliable_ordered", "reliable_unordered"]
    : ["reliable_ordered", "reliable_unordered", "unreliable"];
  return Object.freeze({
    capabilities: Object.freeze({
      guarantees: Object.freeze(guarantees),
      maximum_message_bytes,
    }),
    send: (channel: number, payload: Uint8Array) =>
      (channel === 2 && datagrams !== null ? datagrams : reliable).send(
        payload,
      ),
    close: (reason: string) => {
      reliable.close(reason);
      datagrams?.close(reason);
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
  readonly reason: "protocol" | "engine" | "game" | "schema" | "content";
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
  return { type: "compatible" };
}
export function sequence_newer(first: number, second: number): boolean {
  const a = first >>> 0, b = second >>> 0;
  return a !== b && ((a - b) >>> 0) < 0x8000_0000;
}

export interface Packet {
  readonly sequence: number;
  readonly acknowledgement: number;
  readonly channel: number;
  readonly kind: string;
  readonly payload: unknown;
}
export type PacketParse =
  | { readonly type: "ready"; readonly packet: Packet }
  | { readonly type: "rejected"; readonly reason: string };
const encoder = new TextEncoder(), decoder = new TextDecoder();
export function encode_packet(
  packet: Packet,
  maximum_bytes = 64 * 1024,
): Uint8Array {
  parse_uint(packet.sequence, "sequence", 0xffff_ffff);
  parse_uint(packet.acknowledgement, "acknowledgement", 0xffff_ffff);
  parse_uint(packet.channel, "channel", 0xffff);
  const bytes = encoder.encode(JSON.stringify(packet));
  if (bytes.length > maximum_bytes) {
    throw new Error(`packet length ${bytes.length} exceeds ${maximum_bytes}`);
  }
  return bytes;
}
export function parse_packet(
  bytes: Uint8Array,
  maximum_bytes = 64 * 1024,
): PacketParse {
  if (bytes.length > maximum_bytes) {
    return {
      type: "rejected",
      reason: `packet length ${bytes.length} exceeds ${maximum_bytes}`,
    };
  }
  try {
    const value = JSON.parse(decoder.decode(bytes));
    if (
      !record(value) || !uint(value.sequence, 0xffff_ffff) ||
      !uint(value.acknowledgement, 0xffff_ffff) ||
      !uint(value.channel, 0xffff) || typeof value.kind !== "string" ||
      value.kind.length === 0
    ) return { type: "rejected", reason: "packet fields are malformed" };
    return { type: "ready", packet: value as unknown as Packet };
  } catch {
    return { type: "rejected", reason: "packet is not valid UTF-8 JSON" };
  }
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
  readonly #limit: number;
  readonly #messages = new Map<number, Map<number, Uint8Array>>();
  constructor(limit = 64) {
    this.#limit = limit;
  }
  push(fragment: Fragment): Uint8Array | null {
    if (
      !uint(fragment.index, 0xffff) || !uint(fragment.count, 0xffff) ||
      fragment.count === 0 || fragment.index >= fragment.count
    ) {
      throw new Error(
        `fragment ${fragment.message}:${fragment.index}/${fragment.count} is invalid`,
      );
    }
    let parts = this.#messages.get(fragment.message);
    if (parts === undefined) {
      if (this.#messages.size >= this.#limit) {
        throw new Error(`reassembly queue reached ${this.#limit} messages`);
      }
      parts = new Map();
      this.#messages.set(fragment.message, parts);
    }
    parts.set(fragment.index, fragment.bytes.slice());
    if (parts.size !== fragment.count) return null;
    const length = [...parts.values()].reduce(
      (sum, part) => sum + part.length,
      0,
    );
    const joined = new Uint8Array(length);
    let offset = 0;
    for (let i = 0; i < fragment.count; i++) {
      const part = parts.get(i);
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
    { bytes: Uint8Array; sent_at: number; attempts: number }
  >();
  constructor(limit = 256) {
    this.#limit = limit;
  }
  enqueue(sequence: number, bytes: Uint8Array, now: number): void {
    if (this.#pending.size >= this.#limit) {
      throw new Error(`reliable queue reached ${this.#limit} packets`);
    }
    this.#pending.set(sequence >>> 0, {
      bytes: bytes.slice(),
      sent_at: now,
      attempts: 1,
    });
  }
  acknowledge(sequence: number): void {
    this.#pending.delete(sequence >>> 0);
  }
  retransmissions(now: number, timeout: number): readonly Uint8Array[] {
    const result: Uint8Array[] = [];
    for (const pending of this.#pending.values()) {
      if (now - pending.sent_at >= timeout) {
        pending.sent_at = now;
        pending.attempts++;
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
export interface ReplicationSchema {
  readonly id: string;
  readonly fields: readonly ReplicatedField[];
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
  const previous = new Map(
    (baseline?.entities ?? []).map((
      state,
    ) => [`${state.identity.id}:${state.identity.generation}`, state]),
  );
  const entities: EntityState[] = [];
  let used = 0;
  for (
    const state of [...states].sort((a, b) =>
      a.identity.id - b.identity.id ||
      a.identity.generation - b.identity.generation
    )
  ) {
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
          `schema ${schema.id} field ${field.name} expected ${field.kind}`,
        );
      }
      values[field.name] = typeof source === "number" && field.quantum
        ? Math.round(source / field.quantum) * field.quantum
        : source;
    }
    const encoded = encoder.encode(JSON.stringify(values)).length;
    if (used + encoded > byte_budget) break;
    const old = previous.get(
      `${state.identity.id}:${state.identity.generation}`,
    );
    if (
      old === undefined || JSON.stringify(old.values) !== JSON.stringify(values)
    ) {
      entities.push(Object.freeze({ ...state, values: Object.freeze(values) }));
      used += encoded;
    }
  }
  return Object.freeze({
    tick,
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
  const round_trip = sample.received_at - sample.sent_at;
  if (!Number.isFinite(round_trip) || round_trip < 0) {
    throw new Error(`time sample round trip ${round_trip} must be nonnegative`);
  }
  return Object.freeze({
    round_trip,
    offset: sample.remote_at - (sample.sent_at + round_trip / 2),
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
  const correction = port.error(confirmed, authoritative);
  let state = correction > threshold
    ? port.reconcile(confirmed, authoritative, amount)
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
    this.#options = options;
    this.#random = options.seed >>> 0;
  }
  send(now: number, bytes: Uint8Array): void {
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
  #last_received = 0;
  constructor(transport: Transport, observer?: Observer) {
    this.#transport = transport;
    this.#observer = observer;
  }
  require(guarantee: ChannelGuarantee): void {
    if (!this.#transport.capabilities.guarantees.includes(guarantee)) {
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
      this.#transport.capabilities.maximum_message_bytes,
    );
    if (parsed.type === "rejected") {
      this.#observer?.event("network.packet.rejected", {
        reason: parsed.reason,
      });
    } else this.#last_received = parsed.packet.sequence;
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
      }, this.#transport.capabilities.maximum_message_bytes),
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
