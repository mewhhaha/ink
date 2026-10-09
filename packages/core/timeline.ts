/**
 * The recent past of a play session: every step's input plus periodic state
 * keyframes. Any earlier tick can be rebuilt by replaying inputs from the
 * nearest keyframe, because steps are pure. That gives rewind, scrubbing and
 * exact reproductions for hand-offs at a fraction of the memory of storing
 * every state.
 */
import type { Catalog, InputModel, Schema } from "@ink/schema";
import { EventHistory } from "./events.ts";

export interface Keyframe {
  tick: number;
  state: Float32Array;
  /** Layout the state was written in; migrated lazily when it changed. */
  schema: Schema;
  catalog: Catalog;
}

export interface TimelineMark {
  tick: number;
  kind: "reload" | "edit" | "schema" | "failure";
  label: string;
  detail?: { message: string; png?: string; diff?: string };
}

export class Timeline {
  /** Tick of `inputs[0]`. */
  first = 0;
  inputs: InputModel[] = [];
  keyframes: Keyframe[] = [];
  marks: TimelineMark[] = [];
  readonly events = new EventHistory();
  /** Bumped whenever inputs or keyframes change, so a replay can tell. */
  revision = 0;

  constructor(
    /** Ticks between automatic keyframes. */
    readonly interval = 60,
    /** Ticks kept before the oldest are dropped. */
    readonly capacity = 60 * 60 * 3,
    /** Bytes of keyframe state kept; a large world keeps a shorter past. */
    readonly budget = 256 * 1024 * 1024,
  ) {}

  get last(): number {
    return this.first + this.inputs.length;
  }

  get empty(): boolean {
    return this.keyframes.length === 0;
  }

  reset(keyframe: Keyframe) {
    this.revision++;
    this.first = keyframe.tick;
    this.inputs = [];
    this.keyframes = [keyframe];
    this.marks = [];
    this.events.clear();
  }

  /** Record the step from `state` at `tick` with `input`. */
  record(tick: number, keyframe: () => Keyframe, input: InputModel) {
    this.revision++;
    if (this.keyframes.length === 0 || tick !== this.last) {
      // A discontinuity (first step, or recording after a seek): branch here.
      this.truncate(tick);
      if (this.keyframes.length === 0 || tick < this.first) {
        this.reset(keyframe());
      }
    }
    const newest = this.keyframes[this.keyframes.length - 1];
    if (
      tick - newest.tick >= this.#spacing(newest.state.byteLength) &&
      !this.keyframeAt(tick)
    ) this.keyframes.push(keyframe());
    this.inputs.push(input);
    this.#trim();
  }

  /** Ticks between keyframes: every `interval` for a small world, closer for a
   * large one, so rewinding replays a fraction of a second whatever its size. */
  #spacing(bytes: number): number {
    return Math.max(
      8,
      Math.min(this.interval, Math.round(this.interval * 1048576 / bytes)),
    );
  }

  /** Replace history from `tick` on with a new keyframe, e.g. after an edit. */
  branch(keyframe: Keyframe) {
    this.revision++;
    this.truncate(keyframe.tick);
    if (keyframe.tick < this.first || this.keyframes.length === 0) {
      this.reset(keyframe);
      return;
    }
    this.keyframes = this.keyframes.filter((k) => k.tick !== keyframe.tick);
    this.keyframes.push(keyframe);
  }

  mark(mark: TimelineMark) {
    this.marks.push(mark);
  }

  /** Forget everything after `tick`. */
  truncate(tick: number) {
    if (tick < this.first) return;
    this.revision++;
    this.inputs.length = Math.min(this.inputs.length, tick - this.first);
    this.keyframes = this.keyframes.filter((k) => k.tick <= tick);
    this.marks = this.marks.filter((m) => m.tick <= tick);
    this.events.truncate(tick);
  }

  keyframeAt(tick: number): Keyframe | undefined {
    return this.keyframes.find((k) => k.tick === tick);
  }

  /** The latest keyframe at or before `tick`. */
  nearest(tick: number): Keyframe | undefined {
    let best: Keyframe | undefined;
    for (const k of this.keyframes) {
      if (k.tick <= tick && (!best || k.tick > best.tick)) best = k;
    }
    return best;
  }

  input(tick: number): InputModel | undefined {
    return this.inputs[tick - this.first];
  }

  /** Inputs for ticks `from` (inclusive) to `to` (exclusive). */
  between(from: number, to: number): InputModel[] {
    return this.inputs.slice(from - this.first, to - this.first);
  }

  /** Bytes held by the keyframes' states. */
  get bytes(): number {
    let total = 0;
    const seen = new Set<ArrayBufferLike>();
    for (const k of this.keyframes) {
      if (seen.has(k.state.buffer)) continue;
      seen.add(k.state.buffer);
      total += k.state.buffer.byteLength;
    }
    return total;
  }

  #trim() {
    let excess = this.inputs.length - this.capacity;
    // A large world cannot keep three minutes of keyframes; keep what fits and
    // always the two newest, so a seek never replays from the very start.
    if (this.keyframes.length > 2) {
      let kept = 0;
      let drop = 0;
      for (let i = this.keyframes.length - 1; i >= 0; i--) {
        const buffer = this.keyframes[i].state.buffer;
        kept += buffer.byteLength;
        if (kept > this.budget && i < this.keyframes.length - 2) {
          drop = i + 1;
          break;
        }
      }
      if (drop > 0) {
        excess = Math.max(excess, this.keyframes[drop].tick - this.first);
      }
    }
    if (excess <= 0) return;
    // Drop whole keyframe intervals so the oldest kept tick has a keyframe.
    const cutoff = this.first + excess;
    const keep = this.keyframes.filter((k) => k.tick >= cutoff);
    const start = keep.length > 0
      ? Math.min(...keep.map((k) => k.tick))
      : this.last;
    this.inputs = this.inputs.slice(start - this.first);
    this.first = start;
    this.keyframes = keep;
    this.marks = this.marks.filter((m) => m.tick >= start);
    // Keep preceding context for effects still alive at the oldest keyframe.
    this.events.prune(start - this.capacity);
  }
}
