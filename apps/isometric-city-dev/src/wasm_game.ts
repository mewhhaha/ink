import { create_blot_guest } from "@ink/blot/guest.ts";
import { game_schema_source, parse_blot_manifest } from "@ink/blot/manifest.ts";
import { digest_bytes, digest_text } from "@ink/engine/digest.ts";
import {
  create_headless_session,
  type HeadlessSession,
  type SessionContext,
} from "@ink/engine/headless_session.ts";
import type { GameViewport } from "@ink/engine/protocol.ts";

export async function load_isometric_city(
  wasm_bytes: Uint8Array,
  manifest_source: string,
  viewport?: GameViewport,
): Promise<HeadlessSession> {
  const artifact = await load_isometric_city_artifact(
    wasm_bytes,
    manifest_source,
  );
  return await create_headless_session(
    artifact.guest,
    artifact.context,
    viewport,
  );
}

export async function load_isometric_city_artifact(
  wasm_bytes: Uint8Array,
  manifest_source: string,
): Promise<{
  readonly guest: Awaited<ReturnType<typeof create_blot_guest>>;
  readonly context: SessionContext;
}> {
  const manifest = parse_blot_manifest(manifest_source);
  const [artifact_digest, guest] = await Promise.all([
    digest_bytes(wasm_bytes),
    create_blot_guest(wasm_bytes, manifest),
  ]);
  const schema_digest = await digest_text(
    game_schema_source(manifest, guest.state_schema),
  );
  return {
    guest,
    context: { game_id: "isometric_city", artifact_digest, schema_digest },
  };
}
