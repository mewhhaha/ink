import { Observer } from "@ink/observability/observer.ts";
import { parse_game_artifact } from "@ink/runtime/artifact.ts";
import { digest_bytes, digest_text } from "@ink/runtime/digest.ts";
import { create_runtime_session } from "@ink/runtime/session.ts";
import type { BlotIntegerDataAsset } from "./data_asset.ts";
import type { BlotDevelopmentArtifactLoader } from "./development.ts";
import { create_blot_guest } from "./guest.ts";
import { game_schema_source, parse_blot_manifest } from "./manifest.ts";
import {
  blot_runtime_codec,
  type BlotRuntimeGuest,
  type BlotRuntimeSession,
  create_blot_runtime_guest,
} from "./runtime.ts";

export interface BlotAdapterConfiguration {
  readonly game_id: string;
}

export interface BlotSessionOptions {
  readonly data_assets?: readonly BlotIntegerDataAsset[];
  readonly observer: Observer;
}

export interface BlotGameAdapter {
  readonly artifact_name: string;
  readonly configuration: BlotAdapterConfiguration;
  readonly create_guest: (
    wasm_bytes: Uint8Array,
    manifest_source: string,
    data_assets?: readonly BlotIntegerDataAsset[],
  ) => Promise<BlotRuntimeGuest>;
  readonly create_session: (
    wasm_bytes: Uint8Array,
    manifest_source: string,
    options: BlotSessionOptions,
  ) => Promise<BlotRuntimeSession>;
}

export interface BlotDevelopmentActivationResult {
  readonly revision: string;
  readonly entry_retained: boolean;
  readonly state_preserved: boolean;
}

export interface BlotDevelopmentRuntimeSession {
  readonly session: BlotRuntimeSession;
  active_revision(): string;
  activate(
    revision_descriptor: unknown,
    artifacts: BlotDevelopmentArtifactLoader,
  ): Promise<BlotDevelopmentActivationResult>;
}

export function blot(configuration: BlotAdapterConfiguration): BlotGameAdapter {
  const parsed = parse_configuration(configuration);
  return {
    artifact_name: parsed.game_id,
    configuration: parsed,
    create_guest(wasm_bytes, manifest_source, data_assets = []) {
      return create_artifact_guest(
        parsed.game_id,
        wasm_bytes,
        manifest_source,
        data_assets,
      );
    },
    async create_session(wasm_bytes, manifest_source, options) {
      const guest = await create_artifact_guest(
        parsed.game_id,
        wasm_bytes,
        manifest_source,
        options.data_assets ?? [],
      );
      return await create_runtime_session({
        guest,
        codec: blot_runtime_codec,
        observer: options.observer,
      });
    },
  };
}

export async function create_blot_development_session(
  configuration: BlotAdapterConfiguration,
  revision_descriptor: unknown,
  artifacts: BlotDevelopmentArtifactLoader,
  runtime_module: unknown,
  options: BlotSessionOptions,
): Promise<BlotDevelopmentRuntimeSession> {
  const parsed = parse_configuration(configuration);
  const { create_blot_development_runtime_session } = await import(
    "./development_runtime.ts"
  );
  return await create_blot_development_runtime_session(
    parsed.game_id,
    revision_descriptor,
    artifacts,
    runtime_module,
    options,
  );
}

async function create_artifact_guest(
  game_id: string,
  wasm_bytes: Uint8Array,
  manifest_source: string,
  data_assets: readonly BlotIntegerDataAsset[],
): Promise<BlotRuntimeGuest> {
  if (!(wasm_bytes instanceof Uint8Array)) {
    throw new Error("Blot artifact must be a Uint8Array");
  }
  if (typeof manifest_source !== "string") {
    throw new Error("Blot manifest source must be a string");
  }
  const manifest = parse_blot_manifest(manifest_source);
  const [wasm_digest, wasm_guest] = await Promise.all([
    digest_bytes(wasm_bytes),
    create_blot_guest(wasm_bytes, manifest, data_assets),
  ]);
  const [artifact_digest, schema_digest] = await Promise.all([
    digest_text(JSON.stringify({ wasm_digest, data_assets })),
    digest_text(JSON.stringify({
      guest_schema: game_schema_source(manifest, wasm_guest.state_schema),
      data_assets,
    })),
  ]);
  const artifact = parse_game_artifact({
    guest_id: game_id,
    artifact_digest,
    schema_digest,
    wasm: wasm_bytes,
    capabilities: [],
  });
  return create_blot_runtime_guest({ artifact, wasm_guest });
}

function parse_configuration(configuration: unknown): BlotAdapterConfiguration {
  if (typeof configuration !== "object" || configuration === null) {
    throw new Error(
      `Blot adapter configuration ${
        JSON.stringify(configuration)
      } must be an object`,
    );
  }
  const game_id = Reflect.get(configuration, "game_id");
  if (typeof game_id !== "string" || game_id.trim() === "") {
    throw new Error(
      `Blot adapter game_id ${
        JSON.stringify(game_id)
      } must be a non-empty string`,
    );
  }
  const fields = Object.keys(configuration).sort();
  if (fields.length !== 1 || fields[0] !== "game_id") {
    throw new Error(
      `Blot adapter configuration fields ${
        JSON.stringify(fields)
      } must be ["game_id"]`,
    );
  }
  return { game_id: game_id.trim() };
}
