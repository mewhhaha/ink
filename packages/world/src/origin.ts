import type { Observer } from "@ink/observability/observer.ts";
import type { Vec3 } from "@ink/math/vector.ts";
import { vec3 } from "@ink/math/vector.ts";
import type { GlobalPosition, LocalOrigin } from "./identity.ts";
import { global_to_local, local_origin, positive_finite } from "./identity.ts";

export interface OriginShiftEvent {
  readonly sequence: number;
  readonly previous: LocalOrigin;
  readonly current: LocalOrigin;
  readonly local_translation: Vec3;
}

export interface OriginShiftStage {
  commit(): void;
  rollback(): void;
}

export interface OriginShiftAdapter {
  readonly id: string;
  stage(event: OriginShiftEvent): OriginShiftStage | Promise<OriginShiftStage>;
}

export interface OriginRebaserOptions {
  readonly cell_size: number;
  readonly threshold: number;
  readonly origin: LocalOrigin;
  readonly adapters: readonly OriginShiftAdapter[];
  readonly observer?: Observer;
}

export class OriginRebaser {
  readonly #cell_size: number;
  readonly #threshold: number;
  readonly #adapters: readonly OriginShiftAdapter[];
  readonly #observer: Observer | undefined;
  #origin: LocalOrigin;
  #sequence = 0;

  constructor(options: OriginRebaserOptions) {
    this.#cell_size = positive_finite(
      options.cell_size,
      "origin rebase cell size",
    );
    this.#threshold = positive_finite(
      options.threshold,
      "origin rebase threshold",
    );
    const identities = new Set<string>();
    this.#adapters = Object.freeze(
      [...options.adapters].map((adapter, index) => {
        const id = adapter.id.trim();
        if (id.length === 0 || identities.has(id)) {
          throw new Error(
            `origin shift adapter ${index} id ${
              JSON.stringify(adapter.id)
            } is empty or duplicated`,
          );
        }
        identities.add(id);
        return { id, stage: (event: OriginShiftEvent) => adapter.stage(event) };
      }).sort((left, right) => left.id.localeCompare(right.id)),
    );
    this.#origin = options.origin;
    this.#observer = options.observer;
  }

  get origin(): LocalOrigin {
    return this.#origin;
  }

  async rebase_if_needed(
    focus: GlobalPosition,
  ): Promise<OriginShiftEvent | undefined> {
    const local_focus = global_to_local(focus, this.#origin, this.#cell_size);
    if (
      local_focus.x * local_focus.x + local_focus.z * local_focus.z <=
        this.#threshold * this.#threshold
    ) return undefined;
    return await this.rebase(local_origin(focus));
  }

  async rebase(next: LocalOrigin): Promise<OriginShiftEvent> {
    const previous = this.#origin;
    const previous_from_current = global_to_local(
      previous,
      next,
      this.#cell_size,
    );
    const event = Object.freeze({
      sequence: this.#sequence + 1,
      previous,
      current: next,
      local_translation: vec3(
        previous_from_current.x,
        previous_from_current.y,
        previous_from_current.z,
      ),
    });
    const stages: OriginShiftStage[] = [];
    try {
      for (const adapter of this.#adapters) {
        stages.push(await adapter.stage(event));
      }
      for (const stage of stages) stage.commit();
    } catch (error) {
      const rollback_failures: unknown[] = [];
      for (const stage of stages.reverse()) {
        try {
          stage.rollback();
        } catch (rollback_error) {
          rollback_failures.push(rollback_error);
        }
      }
      if (rollback_failures.length > 0) {
        throw new AggregateError(
          [error, ...rollback_failures],
          `origin shift ${event.sequence} failed and rollback was incomplete`,
        );
      }
      throw error;
    }
    this.#origin = next;
    this.#sequence = event.sequence;
    this.#observer?.event("world.origin.shifted", {
      sequence: event.sequence,
      previous_cell_x: previous.cell_x,
      previous_cell_z: previous.cell_z,
      current_cell_x: next.cell_x,
      current_cell_z: next.cell_z,
      translation_x: event.local_translation.x,
      translation_y: event.local_translation.y,
      translation_z: event.local_translation.z,
    });
    return event;
  }
}
