import {
  type BlotDevelopmentActivationResult,
  type BlotDevelopmentRuntimeSession,
  create_blot_development_session,
} from "@ink/blot/adapter.ts";
import type { BlotIntegerDataAsset } from "@ink/blot/data_asset.ts";
import type { GameAction, GameViewport } from "@ink/blot/protocol.ts";
import type { BlotPresentation } from "@ink/blot/runtime.ts";
import type { Observer } from "@ink/observability/observer.ts";
import type { RuntimeRevision, RuntimeStep } from "@ink/runtime/session.ts";
import { game_adapter } from "../game_adapter.ts";

export interface AdventureDevelopmentRuntimeOptions {
  readonly artifacts: { load(path: string): Promise<Uint8Array> };
  readonly initial_query: GameViewport;
  readonly load_level_asset: () => Promise<BlotIntegerDataAsset>;
  readonly load_revision: () => Promise<unknown>;
  readonly load_runtime_module: () => Promise<unknown>;
  readonly observer: Observer;
}

export class AdventureDevelopmentRuntimeController {
  readonly #options: AdventureDevelopmentRuntimeOptions;
  readonly #level_asset: BlotIntegerDataAsset;
  #active_level_asset: BlotIntegerDataAsset | undefined;
  #development: BlotDevelopmentRuntimeSession | undefined;
  #last_observation: BlotPresentation | undefined;
  #last_query: GameViewport;
  #last_activation: BlotDevelopmentActivationResult | undefined;
  #operations: Promise<void> = Promise.resolve();
  #close_operation: Promise<void> | undefined;

  constructor(options: AdventureDevelopmentRuntimeOptions) {
    this.#options = options;
    this.#last_query = options.initial_query;
    const active_level_asset = () => this.#require_level_asset();
    this.#level_asset = Object.freeze({
      id: 0,
      get fields() {
        return active_level_asset().fields;
      },
      toJSON() {
        return {
          id: 0,
          field_lengths: active_level_asset().fields.map((field) =>
            field.length
          ),
        };
      },
    });
  }

  observation = (): BlotPresentation | undefined => this.#last_observation;

  activation = (): BlotDevelopmentActivationResult | undefined =>
    this.#last_activation;

  active_revision = (): string =>
    this.#require_development("read the active revision").active_revision();

  initialize(): Promise<BlotPresentation> {
    return this.#serialized(async () => {
      if (this.#development !== undefined) {
        return this.#require_observation("initialize");
      }
      const [level_asset, revision, runtime_module] = await Promise.all([
        this.#options.load_level_asset(),
        this.#options.load_revision(),
        this.#options.load_runtime_module(),
      ]);
      this.#active_level_asset = level_asset;
      try {
        this.#development = await create_blot_development_session(
          game_adapter.configuration,
          revision,
          this.#options.artifacts,
          runtime_module,
          {
            data_assets: [this.#level_asset],
            observer: this.#options.observer,
          },
        );
        return await this.#observe();
      } catch (error) {
        await this.#development?.session.close();
        this.#development = undefined;
        this.#active_level_asset = undefined;
        throw error;
      }
    });
  }

  advance(step: RuntimeStep<GameAction>): Promise<RuntimeRevision> {
    return this.#serialized(async () => {
      const revision = await this.#require_development("advance").session
        .advance(step);
      await this.#observe();
      return revision;
    });
  }

  resize(query: GameViewport): Promise<BlotPresentation> {
    return this.#serialized(async () => {
      this.#last_query = query;
      return await this.#observe();
    });
  }

  reset(): Promise<RuntimeRevision> {
    return this.#serialized(async () => {
      const revision = await this.#require_development("reset").session.reset();
      await this.#observe();
      return revision;
    });
  }

  reload(): Promise<{ readonly preserved: boolean }> {
    return this.#serialized(async () => {
      const development = this.#require_development("activate");
      const previous_level_asset = this.#require_level_asset();
      const next_level_asset = await this.#options.load_level_asset();
      this.#active_level_asset = next_level_asset;
      let activation: BlotDevelopmentActivationResult;
      try {
        activation = await development.activate(
          await this.#options.load_revision(),
          this.#options.artifacts,
        );
      } catch (error) {
        this.#active_level_asset = previous_level_asset;
        throw error;
      }
      this.#last_activation = activation;
      await this.#observe();
      return Object.freeze({ preserved: activation.state_preserved });
    });
  }

  close(): Promise<void> {
    if (this.#close_operation !== undefined) return this.#close_operation;
    this.#close_operation = this.#serialized(async () => {
      try {
        await this.#development?.session.close();
      } finally {
        this.#development = undefined;
        this.#active_level_asset = undefined;
      }
    });
    return this.#close_operation;
  }

  async #observe(): Promise<BlotPresentation> {
    const observation = await this.#require_development("observe").session
      .observe(this.#last_query);
    this.#last_observation = observation;
    return observation;
  }

  #require_development(operation: string): BlotDevelopmentRuntimeSession {
    if (this.#development !== undefined) return this.#development;
    throw new Error(
      `adventure development runtime cannot ${operation} before initialization`,
    );
  }

  #require_level_asset(): BlotIntegerDataAsset {
    if (this.#active_level_asset !== undefined) return this.#active_level_asset;
    throw new Error("adventure development runtime has no active level asset");
  }

  #require_observation(operation: string): BlotPresentation {
    if (this.#last_observation !== undefined) return this.#last_observation;
    throw new Error(
      `adventure development runtime cannot ${operation} without an observation`,
    );
  }

  #serialized<Result>(operation: () => Promise<Result>): Promise<Result> {
    const pending = this.#operations.then(operation, operation);
    this.#operations = pending.then(() => undefined, () => undefined);
    return pending;
  }
}
