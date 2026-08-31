import {
  type BlotDevelopmentActivationResult,
  type BlotDevelopmentRuntimeSession,
  create_blot_development_session,
} from "@ink/blot/adapter.ts";
import type { GameAction, GameViewport } from "@ink/blot/protocol.ts";
import {
  blot_runtime_codec,
  type BlotPresentation,
  type BlotRuntimeGuest,
  type BlotRuntimeSession,
} from "@ink/blot/runtime.ts";
import type { DevelopmentControllerState } from "@ink/development/controller.ts";
import type { Observer } from "@ink/observability/observer.ts";
import {
  create_runtime_session,
  type RuntimeRevision,
  type RuntimeStep,
} from "@ink/runtime/session.ts";
import { game_adapter } from "./game_adapter.ts";

export async function create_narrative_guest(
  wasm_bytes: Uint8Array,
  manifest_source: string,
): Promise<BlotRuntimeGuest> {
  return await game_adapter.create_guest(wasm_bytes, manifest_source);
}

export async function create_narrative_session(
  wasm_bytes: Uint8Array,
  manifest_source: string,
  observer: Observer,
): Promise<BlotRuntimeSession> {
  return await create_runtime_session({
    guest: await create_narrative_guest(wasm_bytes, manifest_source),
    codec: blot_runtime_codec,
    observer,
  });
}

export interface NarrativeDevelopmentControllerOptions {
  readonly artifacts: { load(path: string): Promise<Uint8Array> };
  readonly initial_query: GameViewport;
  readonly load_revision: () => Promise<unknown>;
  readonly load_runtime_module: () => Promise<unknown>;
  readonly observer: Observer;
}

export class NarrativeDevelopmentController {
  readonly #options: NarrativeDevelopmentControllerOptions;
  readonly #subscribers = new Set<() => void>();
  #state: DevelopmentControllerState<BlotPresentation> = { type: "loading" };
  #development: BlotDevelopmentRuntimeSession | undefined;
  #last_good: BlotPresentation | undefined;
  #last_activation: BlotDevelopmentActivationResult | undefined;
  #operations: Promise<void> = Promise.resolve();
  #close_operation: Promise<void> | undefined;

  constructor(options: NarrativeDevelopmentControllerOptions) {
    this.#options = options;
  }

  snapshot = (): DevelopmentControllerState<BlotPresentation> => this.#state;

  observation = (): BlotPresentation | undefined => this.#last_good;

  activation = (): BlotDevelopmentActivationResult | undefined =>
    this.#last_activation;

  active_revision = (): string =>
    this.#require_development("read the active revision").active_revision();

  subscribe = (subscriber: () => void): () => void => {
    this.#subscribers.add(subscriber);
    return () => this.#subscribers.delete(subscriber);
  };

  initialize(): Promise<BlotPresentation> {
    return this.#serialized(async () => {
      if (this.#development !== undefined) {
        return this.#require_observation("initialize");
      }
      try {
        this.#development = await create_blot_development_session(
          game_adapter.configuration,
          await this.#options.load_revision(),
          this.#options.artifacts,
          await this.#options.load_runtime_module(),
          { observer: this.#options.observer },
        );
        const observation = await this.#observe();
        this.#publish({ type: "ready", observation });
        return observation;
      } catch (error) {
        await this.#development?.session.close();
        this.#development = undefined;
        this.#publish({ type: "failed", reason: error_reason(error) });
        throw error;
      }
    });
  }

  advance(step: RuntimeStep<GameAction>): Promise<RuntimeRevision> {
    return this.#serialized(async () => {
      const revision = await this.#require_development("advance").session
        .advance(step);
      const observation = await this.#observe();
      this.#publish({ type: "ready", observation });
      return revision;
    });
  }

  reload(): Promise<{ readonly preserved: boolean }> {
    return this.#serialized(async () => {
      const development = this.#require_development("activate");
      this.#publish({ type: "reloading", last_good: this.#last_good });
      try {
        const activation = await development.activate(
          await this.#options.load_revision(),
          this.#options.artifacts,
        );
        this.#last_activation = activation;
        const observation = await this.#observe();
        this.#publish({ type: "ready", observation });
        return Object.freeze({ preserved: activation.state_preserved });
      } catch (error) {
        this.#publish({
          type: "failed_with_last_good",
          last_good: this.#last_good,
          reason: error_reason(error),
        });
        throw error;
      }
    });
  }

  close(): Promise<void> {
    if (this.#close_operation !== undefined) return this.#close_operation;
    this.#close_operation = this.#serialized(async () => {
      if (this.#state.type === "closed") return;
      this.#publish({ type: "closing", last_good: this.#last_good });
      try {
        await this.#development?.session.close();
      } finally {
        this.#development = undefined;
        this.#publish({ type: "closed" });
      }
    });
    return this.#close_operation;
  }

  async #observe(): Promise<BlotPresentation> {
    const observation = await this.#require_development("observe").session
      .observe(this.#options.initial_query);
    this.#last_good = observation;
    return observation;
  }

  #require_development(operation: string): BlotDevelopmentRuntimeSession {
    if (this.#development !== undefined && this.#state.type !== "closing") {
      return this.#development;
    }
    throw new Error(
      `narrative development controller cannot ${operation} while ${this.#state.type}`,
    );
  }

  #require_observation(operation: string): BlotPresentation {
    if (this.#last_good !== undefined) return this.#last_good;
    throw new Error(
      `narrative development controller cannot ${operation} without an observation`,
    );
  }

  #serialized<Result>(operation: () => Promise<Result>): Promise<Result> {
    const pending = this.#operations.then(operation, operation);
    this.#operations = pending.then(() => undefined, () => undefined);
    return pending;
  }

  #publish(state: DevelopmentControllerState<BlotPresentation>): void {
    this.#state = Object.freeze(state);
    for (const subscriber of this.#subscribers) subscriber();
  }
}

function error_reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
