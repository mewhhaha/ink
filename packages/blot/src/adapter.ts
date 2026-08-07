import { digest_bytes, digest_text } from "@ink/runtime/digest.ts";
import { create_blot_guest } from "./guest.ts";
import {
  create_headless_session,
  type HeadlessSession,
  type SessionContext,
} from "./headless_session.ts";
import { game_schema_source, parse_blot_manifest } from "./manifest.ts";
import type { GameViewport } from "./protocol.ts";
import {
  type BlotIntegerDataAsset,
  parse_blot_integer_data_asset,
} from "./data_asset.ts";

export interface BlotDataAssetReference {
  readonly id: number;
  readonly url: string;
}

export interface BlotAdapterConfiguration {
  readonly game_id: string;
  readonly data_assets?: readonly BlotDataAssetReference[];
}

export interface BlotSessionOptions {
  readonly viewport?: GameViewport;
  readonly data_assets?: readonly BlotIntegerDataAsset[];
}

export interface BlotGameAdapter {
  readonly artifact_name: string;
  readonly browser_module: URL;
  readonly browser_factory: "create_blot_artifact_loader";
  readonly configuration: BlotAdapterConfiguration;
  readonly create_session: (
    wasm_bytes: Uint8Array,
    manifest_source: string,
    options?: BlotSessionOptions,
  ) => Promise<HeadlessSession>;
}

export function blot(configuration: BlotAdapterConfiguration): BlotGameAdapter {
  const parsed = parse_configuration(configuration);
  return {
    artifact_name: parsed.game_id,
    browser_module: new URL("./adapter.ts", import.meta.url),
    browser_factory: "create_blot_artifact_loader",
    configuration: parsed,
    async create_session(wasm_bytes, manifest_source, options = {}) {
      const artifact = await create_artifact(
        parsed.game_id,
        wasm_bytes,
        manifest_source,
        options.data_assets ?? [],
      );
      return await create_headless_session(
        artifact.guest,
        artifact.context,
        options.viewport,
      );
    },
  };
}

export function create_blot_artifact_loader(configuration: unknown) {
  const parsed = parse_configuration(configuration);
  return async (wasm_bytes: Uint8Array, manifest_source: string) => {
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
    return await create_artifact(
      parsed.game_id,
      wasm_bytes,
      manifest_source,
      data_assets,
    );
  };
}

async function create_artifact(
  game_id: string,
  wasm_bytes: Uint8Array,
  manifest_source: string,
  data_assets: readonly BlotIntegerDataAsset[],
) {
  if (!(wasm_bytes instanceof Uint8Array)) {
    throw new Error("Blot artifact must be a Uint8Array");
  }
  if (typeof manifest_source !== "string") {
    throw new Error("Blot manifest source must be a string");
  }
  const manifest = parse_blot_manifest(manifest_source);
  const wasm_digest = await digest_bytes(wasm_bytes);
  const [artifact_digest, guest] = await Promise.all([
    digest_text(JSON.stringify({ wasm_digest, data_assets })),
    create_blot_guest(wasm_bytes, manifest, data_assets),
  ]);
  const schema_digest = await digest_text(
    game_schema_source(manifest, guest.state_schema),
  );
  const context: SessionContext = {
    game_id,
    artifact_digest,
    schema_digest,
  };
  return { guest, context };
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
