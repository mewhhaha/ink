import { parse_identity } from "./artifact.ts";

const u64_mask = (1n << 64n) - 1n;
const nonzero_fallback = 0x9e3779b97f4a7c15n;

export interface RandomStreamSnapshot {
  readonly id: string;
  readonly state: string;
}

export interface DeterministicRandomStream {
  next_u64(): bigint;
  next_float(): number;
}

export class DeterministicRandomStreams {
  readonly #seed: bigint;
  readonly #states = new Map<string, bigint>();

  constructor(seed: bigint) {
    if (seed < 0n || seed > u64_mask) {
      throw new Error(`random seed ${seed} must be an unsigned 64-bit integer`);
    }
    this.#seed = seed;
  }

  stream(stream_id: string): DeterministicRandomStream {
    const id = parse_identity(stream_id, "deterministic random stream id");
    if (!this.#states.has(id)) {
      this.#states.set(id, derive_seed(this.#seed, id));
    }
    return {
      next_u64: () => this.#next(id),
      next_float: () => Number(this.#next(id) >> 11n) / 2 ** 53,
    };
  }

  snapshot(): readonly RandomStreamSnapshot[] {
    return [...this.#states.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, state]) =>
        Object.freeze({
          id,
          state: state.toString(16).padStart(16, "0"),
        })
      );
  }

  restore(snapshots: readonly RandomStreamSnapshot[]): void {
    const restored = new Map<string, bigint>();
    for (const [index, snapshot] of snapshots.entries()) {
      const id = parse_identity(
        snapshot.id,
        `random stream snapshot ${index} id`,
      );
      if (restored.has(id)) {
        throw new Error(
          `random stream snapshot duplicates ${JSON.stringify(id)}`,
        );
      }
      if (!/^[0-9a-f]{16}$/.test(snapshot.state)) {
        throw new Error(
          `random stream ${JSON.stringify(id)} state ${
            JSON.stringify(snapshot.state)
          } must be 16 lowercase hexadecimal digits`,
        );
      }
      restored.set(id, BigInt(`0x${snapshot.state}`));
    }
    this.#states.clear();
    for (const [id, state] of restored) this.#states.set(id, state);
  }

  reset(): void {
    this.#states.clear();
  }

  #next(id: string): bigint {
    let state = this.#states.get(id)!;
    state ^= state >> 12n;
    state ^= state << 25n & u64_mask;
    state ^= state >> 27n;
    state &= u64_mask;
    this.#states.set(id, state);
    return state * 0x2545f4914f6cdd1dn & u64_mask;
  }
}

export interface DeterministicChannel {
  readonly id: string;
  snapshot(): Uint8Array | Promise<Uint8Array>;
  restore(payload: Uint8Array): void | Promise<void>;
}

export interface ChannelSnapshot {
  readonly id: string;
  readonly payload: Uint8Array;
}

export class DeterministicChannels {
  readonly #channels: readonly DeterministicChannel[];

  constructor(channels: readonly DeterministicChannel[]) {
    const registered = new Map<string, DeterministicChannel>();
    for (const [index, channel] of channels.entries()) {
      const id = parse_identity(
        channel.id,
        `deterministic channel ${index} id`,
      );
      if (registered.has(id)) {
        throw new Error(
          `deterministic channel ${
            JSON.stringify(id)
          } is registered more than once`,
        );
      }
      registered.set(id, {
        id,
        snapshot: () => channel.snapshot(),
        restore: (payload) => channel.restore(payload),
      });
    }
    this.#channels = [...registered.values()].sort((left, right) =>
      left.id.localeCompare(right.id)
    );
  }

  async snapshot(): Promise<readonly ChannelSnapshot[]> {
    const snapshots: ChannelSnapshot[] = [];
    for (const channel of this.#channels) {
      const payload = await channel.snapshot();
      if (!(payload instanceof Uint8Array)) {
        throw new Error(
          `deterministic channel ${
            JSON.stringify(channel.id)
          } snapshot must be a Uint8Array`,
        );
      }
      snapshots.push({ id: channel.id, payload: payload.slice() });
    }
    return snapshots;
  }

  async restore(snapshots: readonly ChannelSnapshot[]): Promise<void> {
    const supplied = new Map<string, ChannelSnapshot>();
    for (const [index, snapshot] of snapshots.entries()) {
      const id = parse_identity(
        snapshot.id,
        `deterministic channel snapshot ${index} id`,
      );
      if (!(snapshot.payload instanceof Uint8Array)) {
        throw new Error(
          `deterministic channel snapshot ${
            JSON.stringify(id)
          } payload must be a Uint8Array`,
        );
      }
      if (supplied.has(id)) {
        throw new Error(
          `deterministic channel snapshot duplicates ${JSON.stringify(id)}`,
        );
      }
      supplied.set(id, { id, payload: snapshot.payload.slice() });
    }
    const expected = this.#channels.map(({ id }) => id);
    if (
      expected.some((id) => !supplied.has(id)) ||
      supplied.size !== expected.length
    ) {
      throw new Error(
        `deterministic channel snapshot identities ${
          JSON.stringify([...supplied.keys()].sort())
        } do not match registered channels ${JSON.stringify(expected)}`,
      );
    }
    const previous = await this.snapshot();
    const restored: DeterministicChannel[] = [];
    try {
      for (const channel of this.#channels) {
        await channel.restore(supplied.get(channel.id)!.payload.slice());
        restored.push(channel);
      }
    } catch (error) {
      const rollback_failures: unknown[] = [];
      for (const channel of restored.reverse()) {
        try {
          await channel.restore(
            previous.find(({ id }) => id === channel.id)!.payload.slice(),
          );
        } catch (rollback_error) {
          rollback_failures.push(rollback_error);
        }
      }
      if (rollback_failures.length > 0) {
        throw new AggregateError(
          [error, ...rollback_failures],
          "deterministic channel restore failed and rollback was incomplete",
        );
      }
      throw error;
    }
  }
}

function derive_seed(seed: bigint, id: string): bigint {
  let hash = 0xcbf29ce484222325n ^ seed;
  for (const byte of new TextEncoder().encode(id)) {
    hash ^= BigInt(byte);
    hash = hash * 0x100000001b3n & u64_mask;
  }
  return hash === 0n ? nonzero_fallback : hash;
}
