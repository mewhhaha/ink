/**
 * The recent past of a play session: every step's input plus periodic state
 * keyframes. Any earlier tick can be rebuilt by replaying inputs from the
 * nearest keyframe, because steps are pure. That gives rewind, scrubbing and
 * exact reproductions for hand-offs at a fraction of the memory of storing
 * every state.
 */
import type { Catalog, InputModel, Schema } from "@ink/schema";

export interface Keyframe {
  tick: number;
  state: Float32Array;
  /** Layout the state was written in; migrated lazily when it changed. */
  schema: Schema;
  catalog: Catalog;
}

export interface TimelineMark {
  tick: number;
  kind: "reload" | "edit" | "schema";
  label: string;
}

export class Timeline {
  /** Tick of `inputs[0]`. */
  first = 0;
  inputs: InputModel[] = [];
  keyframes: Keyframe[] = [];
  marks: TimelineMark[] = [];

  constructor(
    /** Ticks between automatic keyframes. */
    readonly interval = 60,
    /** Ticks kept before the oldest are dropped. */
    readonly capacity = 60 * 60 * 3,
  ) {}

  get last(): number {
    return this.first + this.inputs.length;
  }

  get empty(): boolean {
    return this.keyframes.length === 0;
  }

  reset(keyframe: Keyframe) {
    this.first = keyframe.tick;
    this.inputs = [];
    this.keyframes = [keyframe];
    this.marks = [];
  }

  /** Record the step from `state` at `tick` with `input`. */
  record(tick: number, keyframe: () => Keyframe, input: InputModel) {
    if (this.keyframes.length === 0 || tick !== this.last) {
      // A discontinuity (first step, or recording after a seek): branch here.
      this.truncate(tick);
      if (this.keyframes.length === 0 || tick < this.first) {
        this.reset(keyframe());
      }
    }
    if ((tick - this.first) % this.interval === 0 && !this.keyframeAt(tick)) {
      this.keyframes.push(keyframe());
    }
    this.inputs.push(input);
    this.#trim();
  }

  /** Replace history from `tick` on with a new keyframe, e.g. after an edit. */
  branch(keyframe: Keyframe) {
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
    this.inputs.length = Math.min(this.inputs.length, tick - this.first);
    this.keyframes = this.keyframes.filter((k) => k.tick <= tick);
    this.marks = this.marks.filter((m) => m.tick <= tick);
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

  #trim() {
    const excess = this.inputs.length - this.capacity;
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
  }
}
