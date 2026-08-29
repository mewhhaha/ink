import type { Observer } from "@ink/observability/observer.ts";
import {
  create_runtime_session,
  type ReloadResult,
  type RuntimeCodec,
  type RuntimeGuest,
  type RuntimeReplay,
  type RuntimeRevision,
  type RuntimeSession,
  type RuntimeStep,
} from "@ink/runtime/session.ts";

export type DevelopmentControllerState<Observation> =
  | { readonly type: "loading" }
  | {
    readonly type: "ready";
    readonly observation: Observation | undefined;
  }
  | {
    readonly type: "reloading";
    readonly last_good: Observation | undefined;
  }
  | {
    readonly type: "failed";
    readonly reason: string;
  }
  | {
    readonly type: "failed_with_last_good";
    readonly last_good: Observation | undefined;
    readonly reason: string;
  }
  | {
    readonly type: "closing";
    readonly last_good: Observation | undefined;
  }
  | { readonly type: "closed" };

export interface DevelopmentControllerOptions<
  Input,
  Query,
  Observation,
  Source,
> {
  readonly load_source: () => Promise<Source>;
  readonly create_guest: (
    source: Source,
  ) => Promise<RuntimeGuest<Input, Query, Observation>>;
  readonly codec: RuntimeCodec<Input>;
  readonly observer: Observer;
  readonly initial_query?: Query;
}

export class DevelopmentController<Input, Query, Observation, Source> {
  readonly #options: DevelopmentControllerOptions<
    Input,
    Query,
    Observation,
    Source
  >;
  readonly #subscribers = new Set<() => void>();
  #state: DevelopmentControllerState<Observation> = { type: "loading" };
  #session: RuntimeSession<Input, Query, Observation> | undefined;
  #last_query: Query | undefined;
  #last_good: Observation | undefined;
  #operations: Promise<void> = Promise.resolve();
  #close_operation: Promise<void> | undefined;

  constructor(
    options: DevelopmentControllerOptions<Input, Query, Observation, Source>,
  ) {
    this.#options = options;
    this.#last_query = options.initial_query;
  }

  snapshot = (): DevelopmentControllerState<Observation> => this.#state;

  observation = (): Observation | undefined => this.#last_good;

  subscribe = (subscriber: () => void): () => void => {
    this.#subscribers.add(subscriber);
    return () => this.#subscribers.delete(subscriber);
  };

  initialize(): Promise<Observation | undefined> {
    return this.#serialized(async () => {
      if (this.#session !== undefined) return this.#last_good;
      if (this.#state.type !== "loading") {
        throw new Error(
          `development controller cannot initialize while ${this.#state.type}`,
        );
      }
      try {
        const source = await this.#options.load_source();
        const guest = await this.#options.create_guest(source);
        this.#session = await create_runtime_session({
          guest,
          codec: this.#options.codec,
          observer: this.#options.observer,
        });
        const observation = await this.#observe_last_query();
        this.#publish({ type: "ready", observation });
        return observation;
      } catch (error) {
        let failure: unknown = error;
        if (this.#session !== undefined) {
          try {
            await this.#session.close();
          } catch (cleanup_error) {
            failure = new AggregateError(
              [error, cleanup_error],
              "development runtime initialization and cleanup failed",
            );
          }
          this.#session = undefined;
        }
        const reason = error_reason(failure);
        this.#publish({ type: "failed", reason });
        throw failure;
      }
    });
  }

  advance(step: RuntimeStep<Input>): Promise<RuntimeRevision> {
    return this.#serialized(async () => {
      const session = this.#require_session("advance");
      const revision = await session.advance(step);
      const observation = await this.#observe_last_query();
      this.#publish({ type: "ready", observation });
      return revision;
    });
  }

  observe(query: Query): Promise<Observation> {
    return this.#serialized(() => this.#observe(query));
  }

  resize(query: Query): Promise<Observation> {
    return this.#serialized(() => this.#observe(query));
  }

  reset(): Promise<RuntimeRevision> {
    return this.#serialized(async () => {
      const revision = await this.#require_session("reset").reset();
      const observation = await this.#observe_last_query();
      this.#publish({ type: "ready", observation });
      return revision;
    });
  }

  save(): Promise<string> {
    return this.#serialized(() => this.#require_session("save").save());
  }

  load(source: string): Promise<RuntimeRevision> {
    return this.#serialized(async () => {
      const revision = await this.#require_session("load").load(source);
      const observation = await this.#observe_last_query();
      this.#publish({ type: "ready", observation });
      return revision;
    });
  }

  finish_replay(): Promise<RuntimeReplay> {
    return this.#serialized(() =>
      this.#require_session("finish replay").finish_replay()
    );
  }

  replay(source: unknown): Promise<RuntimeRevision> {
    return this.#serialized(async () => {
      const revision = await this.#require_session("replay").replay(source);
      const observation = await this.#observe_last_query();
      this.#publish({ type: "ready", observation });
      return revision;
    });
  }

  reload(): Promise<ReloadResult> {
    return this.#serialized(async () => {
      const session = this.#require_session("reload");
      this.#publish({ type: "reloading", last_good: this.#last_good });
      try {
        const source = await this.#options.load_source();
        const guest = await this.#options.create_guest(source);
        const result = await session.reload(guest);
        const observation = await this.#observe_last_query();
        this.#publish({ type: "ready", observation });
        return result;
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
        await this.#session?.close();
      } finally {
        this.#session = undefined;
        this.#publish({ type: "closed" });
      }
    });
    return this.#close_operation;
  }

  async #observe(query: Query): Promise<Observation> {
    this.#last_query = query;
    const observation = await this.#require_session("observe").observe(query);
    this.#last_good = observation;
    this.#publish({ type: "ready", observation });
    return observation;
  }

  async #observe_last_query(): Promise<Observation | undefined> {
    if (this.#last_query === undefined) return this.#last_good;
    const observation = await this.#require_session("observe").observe(
      this.#last_query,
    );
    this.#last_good = observation;
    return observation;
  }

  #require_session(
    operation: string,
  ): RuntimeSession<Input, Query, Observation> {
    if (this.#session !== undefined && this.#state.type !== "closing") {
      return this.#session;
    }
    throw new Error(
      `development controller cannot ${operation} while ${this.#state.type}`,
    );
  }

  #serialized<Result>(operation: () => Promise<Result>): Promise<Result> {
    const pending = this.#operations.then(operation, operation);
    this.#operations = pending.then(() => undefined, () => undefined);
    return pending;
  }

  #publish(state: DevelopmentControllerState<Observation>): void {
    this.#state = Object.freeze(state);
    for (const subscriber of this.#subscribers) subscriber();
  }
}

function error_reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
