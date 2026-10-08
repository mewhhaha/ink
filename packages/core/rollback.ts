/** Deterministic input exchange, prediction and bounded rollback. No transport. */
import {
  type ButtonState,
  decodeInput,
  encodeInput,
  idleInput,
  type InputModel,
  type PlayerInputModel,
  type Schema,
  type StepResult,
} from "@ink/schema";
import type { GameInstance } from "./session.ts";

export interface RollbackFrame {
  input: InputModel;
  before: Float32Array;
  result: StepResult;
  replayed: boolean;
}

export interface RollbackOptions {
  schema: Schema;
  game: Pick<GameInstance, "step">;
  /** Post-start packet, identical on all peers. */
  state: Float32Array;
  peers: number[];
  tickRate?: number;
  mode?: "rollback" | "lockstep";
  keyframeInterval?: number;
  capacity?: number;
  maxPrediction?: number;
  onFrame?(frame: RollbackFrame): void;
  /** Every confirmed state, including its tick (the next input to apply). */
  onConfirm?(tick: number, hash: string): void;
}

export class NetworkError extends Error {
  override name = "NetworkError";
}

/** Hash exact packet bytes, including the layout and tick. For desync detection. */
export function stateHash(state: Float32Array): string {
  let hash = 0x811c9dc5;
  const bytes = new Uint8Array(
    state.buffer,
    state.byteOffset,
    state.byteLength,
  );
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

export class Rollback {
  readonly peers: readonly number[];
  readonly dt: number;
  readonly interval: number;
  readonly capacity: number;
  readonly maxPrediction: number;
  state: Float32Array;
  /** State tick through which all peer inputs are known. */
  confirmed: number;
  rollbacks = 0;
  replayedTicks = 0;
  maxRollback = 0;
  #first: number;
  #actual = new Map<number, Map<number, InputModel>>();
  #used = new Map<number, InputModel>();
  #keyframes = new Map<number, Float32Array>();
  #hashes = new Map<number, string>();
  #remoteHashes = new Map<number, Map<number, string>>();
  #baseline = new Map<number, InputModel>();

  constructor(readonly options: RollbackOptions) {
    this.peers = [...options.peers].sort((a, b) => a - b);
    if (
      this.peers.length < 2 || this.peers.length > 16 ||
      new Set(this.peers).size !== this.peers.length ||
      this.peers.some((p) => !Number.isInteger(p) || p < 0 || p > 0xffffff)
    ) throw new NetworkError("expected 2–16 unique player ids");
    const rate = options.tickRate ?? 60;
    this.dt = 1 / rate;
    this.interval = options.keyframeInterval ?? 8;
    this.capacity = options.capacity ?? 240;
    this.maxPrediction = options.maxPrediction ?? 12;
    if (
      !Number.isInteger(rate) || rate < 1 || rate > 240 ||
      !Number.isInteger(this.interval) || this.interval < 1 ||
      !Number.isInteger(this.capacity) || this.capacity < this.interval * 2 ||
      !Number.isInteger(this.maxPrediction) || this.maxPrediction < 1 ||
      this.maxPrediction > this.capacity - this.interval
    ) throw new NetworkError("invalid rollback window or tick rate");
    this.state = options.state.slice();
    this.confirmed = this.#first = this.tick;
    this.#keyframes.set(this.tick, this.state);
    this.#hashes.set(this.tick, stateHash(this.state));
  }

  get tick() {
    return this.state[1];
  }
  get first() {
    return this.#first;
  }
  get predicted() {
    return this.tick - this.confirmed;
  }
  get canAdvance() {
    return this.options.mode === "lockstep"
      ? this.#complete(this.tick)
      : this.predicted < this.maxPrediction;
  }

  hasInput(peer: number, tick = this.tick) {
    return this.#actual.get(tick)?.has(peer) ?? false;
  }

  /** Validate and copy before retaining; packets and controls cannot be revised. */
  submit(peer: number, input: InputModel) {
    if (!this.peers.includes(peer)) throw new NetworkError("unknown player");
    if (
      !Number.isInteger(input.tick) || input.tick < 0 ||
      input.tick > 0xffffff || input.tick > this.tick + this.capacity ||
      input.players?.length
    ) throw new NetworkError("invalid input tick or nested player inputs");
    if (input.tick < this.#first) {
      throw new NetworkError(
        "input is older than the rollback window; reconnect",
      );
    }
    const value = decodeInput(
      this.options.schema,
      encodeInput(this.options.schema, {
        ...input,
        dt: this.dt,
        time: input.tick * this.dt,
      }),
    );
    let row = this.#actual.get(input.tick);
    const previous = row?.get(peer);
    if (previous) {
      if (!this.#same(previous, value)) {
        throw new NetworkError("a player changed an already submitted input");
      }
      return;
    }
    if (!row) this.#actual.set(input.tick, row = new Map());
    row.set(peer, value);
    const used = this.#used.get(input.tick)?.players?.find((p) =>
      p.id === peer
    );
    if (used && !this.#same({ ...value, ...used }, value)) {
      this.#rollback(input.tick);
    }
    this.#confirm();
  }

  /** One local fixed step. Lockstep returns false until every input arrives. */
  advance(): boolean {
    if (!this.canAdvance) return false;
    this.#step(false);
    this.#confirm();
    this.#trim();
    return true;
  }

  hash(tick = this.confirmed): string | undefined {
    return this.#hashes.get(tick);
  }

  /** Compare only confirmed states. Early remote hashes wait for local inputs. */
  receiveHash(peer: number, tick: number, hash: string) {
    if (
      !this.peers.includes(peer) || !Number.isInteger(tick) ||
      tick < 0 || tick > this.tick + this.capacity ||
      !/^[0-9a-f]{8}$/.test(hash)
    ) throw new NetworkError("invalid state hash");
    if (tick < this.#first) return;
    if (tick <= this.confirmed) this.#checkHash(peer, tick, hash);
    else {
      let row = this.#remoteHashes.get(tick);
      if (!row) this.#remoteHashes.set(tick, row = new Map());
      row.set(peer, hash);
    }
  }

  /** Reconstruct an exact retained state, without emitting presentation events. */
  snapshot(tick: number): Float32Array {
    if (!Number.isInteger(tick) || tick < this.#first || tick > this.tick) {
      throw new NetworkError("snapshot is outside the rollback window");
    }
    const [start, initial] = this.#nearest(tick);
    let state: Float32Array = initial.slice();
    for (let t = start; t < tick; t++) {
      state = this.options.game.step(state, this.#used.get(t)!).state;
      state[1] = t + 1;
    }
    return state;
  }

  #same(a: InputModel, b: InputModel) {
    const encode = (input: InputModel) =>
      encodeInput(this.options.schema, {
        ...input,
        tick: 0,
        dt: 0,
        time: 0,
        players: undefined,
      });
    const x = encode(a), y = encode(b);
    return x.length === y.length && x.every((v, i) => Object.is(v, y[i]));
  }

  #complete(tick: number) {
    return this.#actual.get(tick)?.size === this.peers.length;
  }

  #predict(peer: number, tick: number): InputModel {
    let last = this.#baseline.get(peer) ?? idleInput(this.options.schema);
    for (let t = tick - 1; t >= this.#first; t--) {
      const known = this.#actual.get(t)?.get(peer);
      if (known) {
        last = known;
        break;
      }
    }
    const input = structuredClone(last);
    input.pointer.delta = [0, 0];
    input.pointer.wheel = 0;
    for (const action of this.options.schema.actions) {
      if (action.action.kind === "button") {
        const value = input.actions[action.name] as ButtonState;
        value.pressed = value.released = false;
      }
    }
    return input;
  }

  #step(replayed: boolean) {
    const tick = this.tick;
    const players: PlayerInputModel[] = this.peers.map((id) => {
      const { viewport, pointer, actions } = this.#actual.get(tick)?.get(id) ??
        this.#predict(id, tick);
      return { id, viewport, pointer, actions };
    });
    const input = decodeInput(
      this.options.schema,
      encodeInput(this.options.schema, {
        ...players[0],
        tick,
        dt: this.dt,
        time: tick * this.dt,
        players,
      }),
    );
    this.#used.set(tick, input);
    const before = this.state;
    const result = this.options.game.step(before, input);
    result.state[1] = tick + 1;
    this.state = result.state;
    if ((tick + 1) % this.interval === 0) {
      this.#keyframes.set(tick + 1, this.state);
    }
    this.#hashes.set(tick + 1, stateHash(this.state));
    this.options.onFrame?.({ input, before, result, replayed });
  }

  #nearest(tick: number): [number, Float32Array] {
    let best = this.#first;
    for (const t of this.#keyframes.keys()) if (t <= tick && t > best) best = t;
    return [best, this.#keyframes.get(best)!];
  }

  #rollback(tick: number) {
    const head = this.tick;
    const [start, state] = this.#nearest(tick);
    this.state = state;
    for (const t of this.#keyframes.keys()) {
      if (t > start) this.#keyframes.delete(t);
    }
    this.rollbacks++;
    this.replayedTicks += head - start;
    this.maxRollback = Math.max(this.maxRollback, head - tick);
    while (this.tick < head) this.#step(true);
  }

  #confirm() {
    while (this.confirmed < this.tick && this.#complete(this.confirmed)) {
      this.confirmed++;
      for (const [peer, hash] of this.#remoteHashes.get(this.confirmed) ?? []) {
        this.#checkHash(peer, this.confirmed, hash);
      }
      this.#remoteHashes.delete(this.confirmed);
      this.options.onConfirm?.(
        this.confirmed,
        this.#hashes.get(this.confirmed)!,
      );
    }
  }

  #checkHash(peer: number, tick: number, hash: string) {
    if (this.#hashes.get(tick) !== hash) {
      throw new NetworkError(
        `desync with player ${peer + 1} at tick ${tick}: ${hash} / ${
          this.#hashes.get(tick)
        }`,
      );
    }
  }

  #trim() {
    const cutoff =
      this.#nearest(Math.max(this.#first, this.tick - this.capacity))[0];
    if (cutoff <= this.#first) return;
    for (const peer of this.peers) {
      for (let t = cutoff - 1; t >= this.#first; t--) {
        const known = this.#actual.get(t)?.get(peer);
        if (known) {
          this.#baseline.set(peer, known);
          break;
        }
      }
    }
    this.#first = cutoff;
    for (
      const map of [
        this.#actual,
        this.#used,
        this.#keyframes,
        this.#hashes,
        this.#remoteHashes,
      ]
    ) {
      for (const t of map.keys()) if (t < cutoff) map.delete(t);
    }
  }
}
