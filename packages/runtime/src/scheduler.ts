import { Observer } from "@ink/observability/observer.ts";
import { frame_id } from "./frame.ts";
import type { RuntimeLifecycle } from "./lifecycle.ts";

export interface FrameClock {
  now_seconds(): number;
}

export interface FrameRequest {
  cancel(): void;
}

export interface FrameDriver {
  request_frame(run: () => Promise<void>): FrameRequest;
}

export type SchedulerState =
  | "created"
  | "starting"
  | "running"
  | "paused"
  | "stopping"
  | "stopped";

export interface FixedStepSchedulerOptions {
  readonly runtime: RuntimeLifecycle;
  readonly clock: FrameClock;
  readonly driver: FrameDriver;
  readonly observer: Observer;
  readonly fixed_step_seconds: number;
  readonly max_catch_up_steps: number;
  readonly report_failure: (error: Error) => void;
}

export class FixedStepScheduler {
  readonly #runtime: RuntimeLifecycle;
  readonly #clock: FrameClock;
  readonly #driver: FrameDriver;
  readonly #observer: Observer;
  readonly #fixed_step_seconds: number;
  readonly #max_catch_up_steps: number;
  readonly #report_failure: (error: Error) => void;
  #state: SchedulerState = "created";
  #scheduled_frame: FrameRequest | undefined;
  #active_frame: Promise<void> | undefined;
  #stop_operation: Promise<void> | undefined;
  #last_time_seconds = 0;
  #elapsed_seconds = 0;
  #accumulator_seconds = 0;
  #next_frame_id = 0;
  #fixed_step_sequence = 0;

  constructor(options: FixedStepSchedulerOptions) {
    this.#runtime = options.runtime;
    this.#clock = options.clock;
    this.#driver = options.driver;
    this.#observer = options.observer;
    this.#fixed_step_seconds = parse_positive_finite(
      options.fixed_step_seconds,
      "fixed step seconds",
    );
    if (
      !Number.isSafeInteger(options.max_catch_up_steps) ||
      options.max_catch_up_steps <= 0
    ) {
      throw new Error(
        `maximum catch-up steps ${
          JSON.stringify(options.max_catch_up_steps)
        } must be a positive safe integer`,
      );
    }
    this.#max_catch_up_steps = options.max_catch_up_steps;
    this.#report_failure = options.report_failure;
  }

  get state(): SchedulerState {
    return this.#state;
  }

  async start(): Promise<void> {
    this.#require_state("created", "start");
    this.#state = "starting";
    this.#observer.event("runtime.scheduler.starting");
    try {
      await this.#runtime.initialize();
      await this.#runtime.start();
      this.#last_time_seconds = this.#now("scheduler start");
      this.#state = "running";
      this.#schedule_frame();
      this.#observer.event("runtime.scheduler.running");
    } catch (error) {
      this.#state = "stopping";
      let failure = as_error(error);
      try {
        await this.#runtime.close();
      } catch (cleanup_error) {
        failure = new AggregateError(
          [failure, cleanup_error],
          `runtime scheduler start failed and cleanup also failed`,
        );
      }
      this.#state = "stopped";
      throw failure;
    }
  }

  pause(): void {
    this.#require_state("running", "pause");
    this.#state = "paused";
    this.#cancel_scheduled_frame();
    this.#observer.event("runtime.scheduler.paused", {
      frame: this.#next_frame_id,
      fixed_step_sequence: this.#fixed_step_sequence,
    });
  }

  async resume(): Promise<void> {
    this.#require_state("paused", "resume");
    try {
      this.#last_time_seconds = this.#now("scheduler resume");
      this.#state = "running";
      if (this.#active_frame === undefined) this.#schedule_frame();
      this.#observer.event("runtime.scheduler.resumed", {
        frame: this.#next_frame_id,
        fixed_step_sequence: this.#fixed_step_sequence,
      });
    } catch (error) {
      this.#state = "stopping";
      let failure = as_error(error);
      try {
        await this.#runtime.close();
      } catch (cleanup_error) {
        failure = new AggregateError(
          [failure, cleanup_error],
          "runtime scheduler resume failed and cleanup also failed",
        );
      }
      this.#state = "stopped";
      throw failure;
    }
  }

  stop(): Promise<void> {
    if (this.#stop_operation !== undefined) return this.#stop_operation;
    if (this.#state === "stopped") {
      this.#stop_operation = Promise.resolve();
      return this.#stop_operation;
    }
    if (this.#state === "starting") {
      throw new Error("cannot stop runtime scheduler while it is starting");
    }
    this.#state = "stopping";
    this.#cancel_scheduled_frame();
    this.#stop_operation = this.#finish_stop();
    return this.#stop_operation;
  }

  async #finish_stop(): Promise<void> {
    this.#observer.event("runtime.scheduler.stopping");
    try {
      await this.#active_frame;
      await this.#runtime.close();
    } finally {
      this.#state = "stopped";
      this.#observer.event("runtime.scheduler.stopped");
    }
  }

  #schedule_frame(): void {
    this.#scheduled_frame = this.#driver.request_frame(async () => {
      this.#scheduled_frame = undefined;
      if (this.#state !== "running") return;
      const frame = this.#run_frame();
      this.#active_frame = frame;
      try {
        await frame;
      } catch (error) {
        await this.#stop_after_failure(as_error(error));
        return;
      } finally {
        this.#active_frame = undefined;
      }
      if (this.#state !== "running") return;
      try {
        this.#schedule_frame();
      } catch (error) {
        await this.#stop_after_failure(as_error(error));
      }
    });
  }

  async #run_frame(): Promise<void> {
    const now_seconds = this.#now("scheduled frame");
    const delta_seconds = now_seconds - this.#last_time_seconds;
    if (delta_seconds < 0) {
      throw new Error(
        `runtime frame clock moved backwards from ${this.#last_time_seconds} to ${now_seconds}`,
      );
    }
    this.#last_time_seconds = now_seconds;
    this.#elapsed_seconds += delta_seconds;
    this.#accumulator_seconds += delta_seconds;
    const current_frame_id = frame_id(this.#next_frame_id);
    this.#next_frame_id += 1;

    let completed_steps = 0;
    while (
      this.#accumulator_seconds >= this.#fixed_step_seconds &&
      completed_steps < this.#max_catch_up_steps
    ) {
      await this.#runtime.fixed_step(Object.freeze({
        frame_id: current_frame_id,
        fixed_step_sequence: this.#fixed_step_sequence,
        simulation_time_seconds: (this.#fixed_step_sequence + 1) *
          this.#fixed_step_seconds,
        delta_seconds: this.#fixed_step_seconds,
      }));
      this.#fixed_step_sequence += 1;
      this.#accumulator_seconds -= this.#fixed_step_seconds;
      completed_steps += 1;
    }

    if (this.#accumulator_seconds >= this.#fixed_step_seconds) {
      const dropped_steps = Math.floor(
        this.#accumulator_seconds / this.#fixed_step_seconds,
      );
      const dropped_seconds = dropped_steps * this.#fixed_step_seconds;
      this.#accumulator_seconds -= dropped_seconds;
      this.#observer.event("runtime.scheduler.catch_up_clamped", {
        frame: current_frame_id,
        completed_steps,
        dropped_steps,
        dropped_seconds,
      });
    }

    await this.#runtime.frame(Object.freeze({
      frame_id: current_frame_id,
      fixed_step_sequence: this.#fixed_step_sequence,
      elapsed_seconds: this.#elapsed_seconds,
      delta_seconds,
      interpolation: this.#accumulator_seconds / this.#fixed_step_seconds,
    }));
  }

  async #stop_after_failure(failure: Error): Promise<void> {
    this.#state = "stopping";
    this.#observer.diagnostic(
      "error",
      "runtime.scheduler.frame",
      "scheduled runtime frame failed",
      { reason: failure.message, frame: this.#next_frame_id - 1 },
    );
    try {
      await this.#runtime.close();
    } catch (cleanup_error) {
      failure = new AggregateError(
        [failure, cleanup_error],
        "scheduled runtime frame failed and cleanup also failed",
      );
    }
    this.#state = "stopped";
    this.#report_failure(failure);
  }

  #cancel_scheduled_frame(): void {
    this.#scheduled_frame?.cancel();
    this.#scheduled_frame = undefined;
  }

  #now(operation: string): number {
    const now_seconds = this.#clock.now_seconds();
    if (!Number.isFinite(now_seconds) || now_seconds < 0) {
      throw new Error(
        `${operation} clock returned ${
          JSON.stringify(now_seconds)
        }; expected finite nonnegative seconds`,
      );
    }
    return now_seconds;
  }

  #require_state(expected: SchedulerState, operation: string): void {
    if (this.#state !== expected) {
      throw new Error(
        `cannot ${operation} runtime scheduler while it is ${this.#state}; expected ${expected}`,
      );
    }
  }
}

function parse_positive_finite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `${label} ${JSON.stringify(value)} must be finite and positive`,
    );
  }
  return value;
}

function as_error(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
