import type { Game } from "@ink/blot";
import { InputState } from "@ink/core/input";
import {
  type Catalog,
  decodeWorld,
  encodeWorld,
  type EventModel,
  type InputModel,
  type SceneFile,
  sceneToWorld,
  type Schema,
  type WorldModel,
} from "@ink/schema";

/** Shipping runtime: pure fixed steps, input and events, without editor state. */
export class Player {
  readonly input: InputState;
  readonly dt: number;
  state: Float32Array;
  paused = false;
  #initial: Float32Array;
  #decoded: { state: Float32Array; world: WorldModel } | null = null;
  #time = 0;
  #accumulator = 0;
  #events = new Set<(events: EventModel[], tick: number) => void>();

  constructor(
    readonly schema: Schema,
    readonly catalog: Catalog,
    readonly game: Game,
    scene: SceneFile,
    tickRate = 60,
  ) {
    if (!Number.isFinite(tickRate) || tickRate < 1 || tickRate > 1000) {
      throw new Error("invalid tick rate");
    }
    const loaded = sceneToWorld(schema, scene, catalog);
    if (loaded.problems.length) throw new Error(loaded.problems.join("\n"));
    this.dt = 1 / tickRate;
    this.input = new InputState(schema);
    this.state = this.#initial = encodeWorld(schema, loaded.world);
    this.restart();
  }

  get tick() {
    return this.state[1];
  }
  get world(): WorldModel {
    if (this.#decoded?.state !== this.state) {
      this.#decoded = {
        state: this.state,
        world: decodeWorld(this.schema, this.state),
      };
    }
    return this.#decoded.world;
  }
  onEvents(listener: (events: EventModel[], tick: number) => void): () => void {
    this.#events.add(listener);
    return () => {
      this.#events.delete(listener);
    };
  }
  restart() {
    this.input.reset();
    this.state = this.#initial.slice();
    this.#time = this.tick * this.dt;
    this.#accumulator = 0;
    if (this.game.hasStart && this.tick === 0) {
      const result = this.game.start(
        this.state,
        this.input.sample(this.tick, this.dt, this.#time),
      );
      this.state = result.state;
      this.#dispatch(result.events);
    }
  }
  step(recorded?: InputModel) {
    const tick = this.tick;
    const input = recorded
      ? { ...structuredClone(recorded), tick, dt: this.dt, time: this.#time }
      : this.input.sample(tick, this.dt, this.#time);
    const result = this.game.step(this.state, input);
    this.state = result.state;
    this.state[1] = tick + 1;
    this.#time += this.dt;
    this.#dispatch(result.events);
  }
  advance(seconds: number) {
    if (this.paused) {
      this.#accumulator = 0;
      return;
    }
    this.#accumulator += Math.max(0, Math.min(0.25, seconds));
    while (this.#accumulator >= this.dt) {
      this.step();
      this.#accumulator -= this.dt;
    }
  }
  #dispatch(events: EventModel[]) {
    for (const listener of this.#events) listener(events, this.tick);
  }
  dispose() {
    this.game.dispose();
    this.#events.clear();
  }
}
