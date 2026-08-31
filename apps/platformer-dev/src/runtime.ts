import {
  type BlotDevelopmentActivationResult,
  type BlotDevelopmentRuntimeSession,
  create_blot_development_session,
} from "@ink/blot/adapter.ts";
import {
  type BlotIntegerDataAsset,
  parse_blot_integer_data_asset,
} from "@ink/blot/data_asset.ts";
import type { BlotRuntimeSession } from "@ink/blot/runtime.ts";
import {
  create_debugger_observation_log,
  type DebuggerObservationLog,
  type DebuggerRecordAction,
} from "@ink/development/debugger.ts";
import { Observer } from "@ink/observability/observer.ts";
import { game_adapter } from "./game_adapter.ts";

const observation_capacity = 16;

export interface PlatformerObservationBoundary {
  readonly observer: Observer;
  readonly log: DebuggerObservationLog;
  readonly debugger_entries: () => readonly DebuggerRecordAction[];
}

export interface PlatformerRuntime {
  readonly session: BlotRuntimeSession;
  readonly observations: PlatformerObservationBoundary;
}

export interface PlatformerDevelopmentRuntime extends PlatformerRuntime {
  readonly development: BlotDevelopmentRuntimeSession;
  activate(
    revision_descriptor: unknown,
    artifacts: { load(path: string): Promise<Uint8Array> },
    level_source: string,
  ): Promise<BlotDevelopmentActivationResult>;
}

export interface PlatformerArtifactSource {
  readonly wasm_bytes: Uint8Array;
  readonly manifest_source: string;
  readonly level_source: string;
}

export async function create_platformer_runtime(
  artifact: PlatformerArtifactSource,
): Promise<PlatformerRuntime> {
  const observations = platformer_observations();
  const session = await game_adapter.create_session(
    artifact.wasm_bytes,
    artifact.manifest_source,
    {
      data_assets: [parse_blot_integer_data_asset(0, artifact.level_source)],
      observer: observations.observer,
    },
  );
  return Object.freeze({ session, observations });
}

export async function create_platformer_development_runtime(
  revision_descriptor: unknown,
  artifacts: { load(path: string): Promise<Uint8Array> },
  runtime_module: unknown,
  level_source: string,
): Promise<PlatformerDevelopmentRuntime> {
  const observations = platformer_observations();
  let active_level_asset = parse_blot_integer_data_asset(0, level_source);
  const level_asset: BlotIntegerDataAsset = Object.freeze({
    id: 0,
    get fields() {
      return active_level_asset.fields;
    },
    toJSON() {
      return {
        id: 0,
        field_lengths: active_level_asset.fields.map((field) => field.length),
      };
    },
  });
  const development = await create_blot_development_session(
    game_adapter.configuration,
    revision_descriptor,
    artifacts,
    runtime_module,
    {
      data_assets: [level_asset],
      observer: observations.observer,
    },
  );
  return Object.freeze({
    development,
    session: development.session,
    observations,
    async activate(
      revision_descriptor: unknown,
      artifacts: { load(path: string): Promise<Uint8Array> },
      next_level_source: string,
    ) {
      const previous_level_asset = active_level_asset;
      active_level_asset = parse_blot_integer_data_asset(
        0,
        next_level_source,
      );
      try {
        return await development.activate(revision_descriptor, artifacts);
      } catch (error) {
        active_level_asset = previous_level_asset;
        throw error;
      }
    },
  });
}

function platformer_observations(): PlatformerObservationBoundary {
  const debugger_entries: DebuggerRecordAction[] = [];
  const log = create_debugger_observation_log({
    capacity: observation_capacity,
    record(entry) {
      if (debugger_entries.length === observation_capacity) {
        debugger_entries.shift();
      }
      debugger_entries.push(entry);
    },
  });
  const observations = Object.freeze({
    observer: new Observer({
      source: { subsystem: "platformer-runtime", instance: "game" },
      sink: log,
      clock: { now_seconds: () => performance.now() / 1_000 },
    }),
    log,
    debugger_entries: () => Object.freeze([...debugger_entries]),
  });
  return observations;
}
