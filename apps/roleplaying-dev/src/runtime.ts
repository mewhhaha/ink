import {
  type BlotDevelopmentRuntimeSession,
  create_blot_development_session,
} from "@ink/blot/adapter.ts";
import type { BlotRuntimeSession } from "@ink/blot/runtime.ts";
import {
  create_debugger_observation_log,
  type DebuggerObservationLog,
  type DebuggerRecordAction,
} from "@ink/development/debugger.ts";
import { Observer } from "@ink/observability/observer.ts";
import { game_adapter } from "./game_adapter.ts";

const observation_capacity = 16;

export interface RoleplayingObservationBoundary {
  readonly observer: Observer;
  readonly log: DebuggerObservationLog;
  readonly debugger_entries: () => readonly DebuggerRecordAction[];
}

export interface RoleplayingRuntime {
  readonly session: BlotRuntimeSession;
  readonly observations: RoleplayingObservationBoundary;
}

export interface RoleplayingDevelopmentRuntime extends RoleplayingRuntime {
  readonly development: BlotDevelopmentRuntimeSession;
}

export interface RoleplayingArtifactSource {
  readonly wasm_bytes: Uint8Array;
  readonly manifest_source: string;
}

export async function create_roleplaying_runtime(
  artifact: RoleplayingArtifactSource,
): Promise<RoleplayingRuntime> {
  const observations = roleplaying_observations();
  const session = await game_adapter.create_session(
    artifact.wasm_bytes,
    artifact.manifest_source,
    { observer: observations.observer },
  );
  return Object.freeze({ session, observations });
}

export async function create_roleplaying_development_runtime(
  revision_descriptor: unknown,
  artifacts: { load(path: string): Promise<Uint8Array> },
  runtime_module: unknown,
): Promise<RoleplayingDevelopmentRuntime> {
  const observations = roleplaying_observations();
  const development = await create_blot_development_session(
    game_adapter.configuration,
    revision_descriptor,
    artifacts,
    runtime_module,
    { observer: observations.observer },
  );
  return Object.freeze({
    development,
    session: development.session,
    observations,
  });
}

function roleplaying_observations(): RoleplayingObservationBoundary {
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
      source: { subsystem: "roleplaying-runtime", instance: "game" },
      sink: log,
      clock: { now_seconds: () => performance.now() / 1_000 },
    }),
    log,
    debugger_entries: () => Object.freeze([...debugger_entries]),
  });
  return observations;
}
