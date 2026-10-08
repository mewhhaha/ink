import type { EventModel } from "@ink/schema";

/** Events are stamped with the state tick at which they become visible. */
export interface TimedEvents {
  tick: number;
  events: EventModel[];
}

/** Replayable presentation, separate from the game packet and audio dispatch.
 * Owners prune with their snapshot window, and replace corrected ticks. */
export class EventHistory {
  #frames = new Map<number, EventModel[]>();
  version = 0;

  record(tick: number, events: readonly EventModel[]) {
    this.version++;
    if (events.length) this.#frames.set(tick, structuredClone([...events]));
    else this.#frames.delete(tick);
  }
  between(from: number, to: number): TimedEvents[] {
    return [...this.#frames].filter(([tick]) => tick >= from && tick <= to)
      .sort(([a], [b]) => a - b).map(([tick, events]) => ({ tick, events }));
  }
  truncate(tick: number) {
    this.version++;
    for (const t of this.#frames.keys()) if (t > tick) this.#frames.delete(t);
  }
  prune(before: number) {
    this.version++;
    for (const t of this.#frames.keys()) if (t < before) this.#frames.delete(t);
  }
  clear() {
    this.version++;
    this.#frames.clear();
  }
}
