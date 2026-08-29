import { Observer } from "@ink/observability/observer.ts";
import { no_observations } from "@ink/observability/sink.ts";
import { parse_game_artifact } from "@ink/runtime/artifact.ts";
import { digest_bytes, digest_text } from "@ink/runtime/digest.ts";
import { create_runtime_session } from "@ink/runtime/session.ts";
import {
  type BlotIntegerDataAsset,
  parse_blot_integer_data_asset,
} from "./data_asset.ts";
import { create_blot_guest } from "./guest.ts";
import { game_schema_source, parse_blot_manifest } from "./manifest.ts";
import {
  blot_runtime_codec,
  type BlotRuntimeGuest,
  type BlotRuntimeSession,
  create_blot_runtime_guest,
} from "./runtime.ts";

export interface BlotDataAssetReference {
  readonly id: number;
  readonly url: string;
}

export interface BlotAdapterConfiguration {
  readonly game_id: string;
  readonly data_assets?: readonly BlotDataAssetReference[];
}

export interface BlotSessionOptions {
  readonly data_assets?: readonly BlotIntegerDataAsset[];
  readonly observer?: Observer;
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
    options?: BlotSessionOptions,
  ) => Promise<BlotRuntimeSession>;
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
    async create_session(wasm_bytes, manifest_source, options = {}) {
      const guest = await create_artifact_guest(
        parsed.game_id,
        wasm_bytes,
        manifest_source,
        options.data_assets ?? [],
      );
      return await create_runtime_session({
        guest,
        codec: blot_runtime_codec,
        observer: options.observer ?? default_observer(parsed.game_id),
      });
    },
  };
}

export function create_blot_artifact_loader(configuration: unknown) {
  const parsed = parse_configuration(configuration);
  return async (
    wasm_bytes: Uint8Array,
    manifest_source: string,
  ): Promise<BlotRuntimeGuest> => {
    const data_assets = await Promise.all(
      (parsed.data_assets ?? []).map(async (reference) => {
        const response = await fetch(reference.url, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(
            `Blot data asset ${reference.id} ${
              JSON.stringify(reference.url)
            } returned ${response.status}`,
          );
        }
        return parse_blot_integer_data_asset(
          reference.id,
          await response.text(),
        );
      }),
    );
    return await create_artifact_guest(
      parsed.game_id,
      wasm_bytes,
      manifest_source,
      data_assets,
    );
  };
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

function default_observer(game_id: string): Observer {
  return new Observer({
    source: { subsystem: "blot", instance: game_id },
    sink: no_observations,
    clock: { now_seconds: () => performance.now() / 1000 },
  });
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
  const references = Reflect.get(configuration, "data_assets");
  if (references !== undefined && !Array.isArray(references)) {
    throw new Error("Blot adapter data_assets must be an array");
  }
  const data_assets: BlotDataAssetReference[] = (references ?? []).map(
    (reference: unknown, index: number): BlotDataAssetReference => {
      if (typeof reference !== "object" || reference === null) {
        throw new Error(`Blot adapter data_assets[${index}] must be an object`);
      }
      const id = Reflect.get(reference, "id");
      const url = Reflect.get(reference, "url");
      if (!Number.isSafeInteger(id) || id < 0) {
        throw new Error(
          `Blot adapter data_assets[${index}].id ${
            JSON.stringify(id)
          } must be a nonnegative safe integer`,
        );
      }
      if (typeof url !== "string" || url.trim() === "") {
        throw new Error(
          `Blot adapter data_assets[${index}].url ${
            JSON.stringify(url)
          } must be a non-empty string`,
        );
      }
      return { id, url: url.trim() };
    },
  );
  const ids = new Set(data_assets.map(({ id }) => id));
  if (ids.size !== data_assets.length) {
    throw new Error("Blot adapter data asset ids must be unique");
  }
  return data_assets.length === 0
    ? { game_id: game_id.trim() }
    : { game_id: game_id.trim(), data_assets };
}
