import {
  blot_runtime_codec,
  type BlotRuntimeSession,
} from "@ink/blot/runtime.ts";
import { Observer } from "@ink/observability/observer.ts";
import { no_observations } from "@ink/observability/sink.ts";
import { create_runtime_session } from "@ink/runtime/session.ts";
import { game_adapter } from "./game_adapter.ts";

export async function create_roleplaying_session(
  wasm_bytes: Uint8Array,
  manifest_source: string,
): Promise<BlotRuntimeSession> {
  return await create_runtime_session({
    guest: await game_adapter.create_guest(wasm_bytes, manifest_source),
    codec: blot_runtime_codec,
    observer: new Observer({
      source: { subsystem: "roleplaying-runtime" },
      sink: no_observations,
      clock: { now_seconds: () => performance.now() / 1_000 },
    }),
  });
}
