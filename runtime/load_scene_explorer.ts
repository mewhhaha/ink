import { create_blot_guest } from "./blot_guest.ts";
import { game_schema_source, parse_blot_manifest } from "./blot_manifest.ts";
import { digest_bytes, digest_text } from "./digest.ts";
import {
  create_headless_session,
  type HeadlessSession,
  type SessionContext,
} from "./headless_session.ts";
import type { GameViewport } from "./protocol.ts";

export async function load_scene_explorer(
  wasm_bytes: Uint8Array,
  manifest_source: string,
  viewport?: GameViewport,
): Promise<HeadlessSession> {
  const artifact = await load_scene_explorer_artifact(
    wasm_bytes,
    manifest_source,
  );
  return await create_headless_session(
    artifact.guest,
    artifact.context,
    viewport,
  );
}

export async function load_scene_explorer_artifact(
  wasm_bytes: Uint8Array,
  manifest_source: string,
): Promise<{
  readonly guest: Awaited<ReturnType<typeof create_blot_guest>>;
  readonly context: SessionContext;
}> {
  const manifest = parse_blot_manifest(manifest_source);
  const [artifact_digest, schema_digest] = await Promise.all([
    digest_bytes(wasm_bytes),
    digest_text(game_schema_source(manifest)),
  ]);
  return {
    guest: await create_blot_guest(wasm_bytes, manifest),
    context: { artifact_digest, schema_digest },
  };
}
