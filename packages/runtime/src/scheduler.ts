import { frame_id, type FrameId } from "./frame.ts";
import {
  type Microseconds,
  microseconds,
  runtime_sequence,
  type RuntimeSequence,
} from "./identity.ts";
import type { RuntimeLifecycle } from "./lifecycle.ts";

export interface RuntimeScheduleSnapshot {
  readonly elapsed_us: Microseconds;
  readonly accumulator_us: Microseconds;
  readonly next_frame_id: FrameId;
  readonly fixed_step_sequence: RuntimeSequence;
}

export interface RuntimeStepSchedulerOptions {
  readonly runtime: RuntimeLifecycle;
  readonly fixed_step_us?: Microseconds;
  readonly maximum_catch_up_steps?: number;
}

export function initial_runtime_schedule(): RuntimeScheduleSnapshot {
  return Object.freeze({
    elapsed_us: microseconds(0),
    accumulator_us: microseconds(0),
    next_frame_id: frame_id(0),
    fixed_step_sequence: runtime_sequence(0),
  });
}

export class RuntimeStepScheduler {
  readonly #runtime: RuntimeLifecycle;
  readonly #fixed_step_us: Microseconds;
  readonly #maximum_catch_up_steps: number;
  #current = initial_runtime_schedule();

  constructor(options: RuntimeStepSchedulerOptions) {
    this.#runtime = options.runtime;
    this.#fixed_step_us = options.fixed_step_us ?? microseconds(16_667);
    if (this.#fixed_step_us === 0) {
      throw new Error("runtime fixed step must be positive");
    }
    const maximum_catch_up_steps = options.maximum_catch_up_steps ?? 8;
    if (
      !Number.isSafeInteger(maximum_catch_up_steps) ||
      maximum_catch_up_steps <= 0
    ) {
      throw new Error(
        `maximum catch-up steps ${
          JSON.stringify(maximum_catch_up_steps)
        } must be a positive safe integer`,
      );
    }
    this.#maximum_catch_up_steps = maximum_catch_up_steps;
  }

  snapshot(): RuntimeScheduleSnapshot {
    return this.#current;
  }

  restore(snapshot: RuntimeScheduleSnapshot): void {
    this.#current = Object.freeze({ ...snapshot });
  }

  reset(): void {
    this.#current = initial_runtime_schedule();
  }

  async advance(elapsed_us: Microseconds): Promise<void> {
    const next_elapsed_us = microseconds(this.#current.elapsed_us + elapsed_us);
    let accumulator_us = microseconds(
      this.#current.accumulator_us + elapsed_us,
    );
    let fixed_step_sequence = this.#current.fixed_step_sequence;
    let completed_steps = 0;
    while (
      accumulator_us >= this.#fixed_step_us &&
      completed_steps < this.#maximum_catch_up_steps
    ) {
      await this.#runtime.fixed_step(Object.freeze({
        frame_id: this.#current.next_frame_id,
        fixed_step_sequence,
        simulation_time_seconds: (fixed_step_sequence + 1) *
          this.#fixed_step_us / 1_000_000,
        delta_seconds: this.#fixed_step_us / 1_000_000,
      }));
      fixed_step_sequence = runtime_sequence(fixed_step_sequence + 1);
      accumulator_us = microseconds(accumulator_us - this.#fixed_step_us);
      completed_steps += 1;
    }

    if (accumulator_us >= this.#fixed_step_us) {
      const dropped_steps = Math.floor(accumulator_us / this.#fixed_step_us);
      accumulator_us = microseconds(
        accumulator_us - dropped_steps * this.#fixed_step_us,
      );
    }
    await this.#runtime.frame(Object.freeze({
      frame_id: this.#current.next_frame_id,
      fixed_step_sequence,
      elapsed_seconds: next_elapsed_us / 1_000_000,
      delta_seconds: elapsed_us / 1_000_000,
      interpolation: accumulator_us / this.#fixed_step_us,
    }));
    this.#current = Object.freeze({
      elapsed_us: next_elapsed_us,
      accumulator_us,
      next_frame_id: frame_id(this.#current.next_frame_id + 1),
      fixed_step_sequence,
    });
  }
}
