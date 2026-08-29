import {
  blot_runtime_codec,
  type BlotRuntimeGuest,
  type BlotRuntimeSession,
} from "@ink/blot/runtime.ts";
import { Observer } from "@ink/observability/observer.ts";
import { no_observations } from "@ink/observability/sink.ts";
import { create_runtime_session } from "@ink/runtime/session.ts";
import { game_adapter } from "./game_adapter.ts";
import { present_platformer } from "./presentation.ts";

export async function create_platformer_guest(
  wasm_bytes: Uint8Array,
  manifest_source: string,
): Promise<BlotRuntimeGuest> {
  const guest = await game_adapter.create_guest(wasm_bytes, manifest_source);
  return {
    artifact: guest.artifact,
    blocks: guest.blocks,
    reset: (context) => guest.reset(context),
    advance: (step, context) => guest.advance(step, context),
    async observe(query) {
      return present_platformer(await guest.observe(query), query);
    },
    snapshot: () => guest.snapshot(),
    restore: (payload) => guest.restore(payload),
    close: () => guest.close(),
  };
}

export async function create_platformer_session(
  wasm_bytes: Uint8Array,
  manifest_source: string,
): Promise<BlotRuntimeSession> {
  return await create_runtime_session({
    guest: await create_platformer_guest(wasm_bytes, manifest_source),
    codec: blot_runtime_codec,
    observer: new Observer({
      source: { subsystem: "platformer-runtime" },
      sink: no_observations,
      clock: { now_seconds: () => performance.now() / 1_000 },
    }),
  });
}
