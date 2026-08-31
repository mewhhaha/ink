import { parse_game_artifact } from "@ink/runtime/artifact.ts";
import { digest_text } from "@ink/runtime/digest.ts";
import { create_runtime_session } from "@ink/runtime/session.ts";
import type {
  DevelopmentActivation,
  DevelopmentBuild,
  DevelopmentRuntime,
  DevelopmentRuntimeContext,
} from "./compiler_api.d.ts";
import type {
  BlotDevelopmentRuntimeSession,
  BlotSessionOptions,
} from "./adapter.ts";
import type { BlotIntegerDataAsset } from "./data_asset.ts";
import {
  type BlotDevelopmentArtifactLoader,
  materialize_blot_development_delta,
  materialize_blot_development_snapshot,
  parse_blot_development_revision,
  type ParsedBlotDevelopmentRevision,
} from "./development.ts";
import type { GameGuest } from "./game_guest.ts";
import { create_blot_guest } from "./guest.ts";
import { game_schema_source, parse_blot_manifest } from "./manifest.ts";
import {
  blot_runtime_codec,
  type BlotRuntimeGuest,
  create_blot_runtime_guest,
} from "./runtime.ts";

type DevelopmentRuntimeFactory = (
  imports: (
    context: DevelopmentRuntimeContext,
  ) => WebAssembly.Imports | Promise<WebAssembly.Imports>,
) => DevelopmentRuntime;

function parse_development_runtime_module(
  value: unknown,
): DevelopmentRuntimeFactory {
  if (typeof value !== "object" || value === null) {
    throw new Error("Blot development runtime module must be an object");
  }
  const constructor = Reflect.get(value, "DevelopmentRuntime");
  if (typeof constructor !== "function") {
    throw new Error(
      "Blot development runtime module must export DevelopmentRuntime",
    );
  }
  return (imports) => {
    const runtime: unknown = Reflect.construct(constructor, [imports]);
    if (
      typeof runtime !== "object" || runtime === null ||
      typeof Reflect.get(runtime, "prepareActivation") !== "function" ||
      typeof Reflect.get(runtime, "commitActivation") !== "function" ||
      typeof Reflect.get(runtime, "abortActivation") !== "function" ||
      typeof Reflect.get(runtime, "unitInstance") !== "function"
    ) {
      throw new Error("Blot DevelopmentRuntime has an invalid interface");
    }
    const revision = Reflect.get(runtime, "revision");
    if (revision !== undefined && typeof revision !== "string") {
      throw new Error(
        `Blot DevelopmentRuntime revision ${
          JSON.stringify(revision)
        } must be text or undefined`,
      );
    }
    return runtime as DevelopmentRuntime;
  };
}

interface ActiveBlotDevelopmentRuntime {
  readonly revision: string;
  readonly entry_unit: string;
  readonly entry_wasm: Uint8Array;
  readonly entry_manifest_source: string;
  readonly runtime: DevelopmentRuntime;
  readonly wasm_guest: GameGuest;
}

export async function create_blot_development_runtime_session(
  game_id: string,
  revision_descriptor: unknown,
  artifacts: BlotDevelopmentArtifactLoader,
  runtime_module: unknown,
  options: BlotSessionOptions,
): Promise<BlotDevelopmentRuntimeSession> {
  const create_runtime = parse_development_runtime_module(runtime_module);
  const revision = parse_blot_development_revision(revision_descriptor);
  const snapshot = await materialize_blot_development_snapshot(
    revision,
    artifacts,
  );
  let active = await instantiate_development_runtime(
    revision,
    snapshot,
    options.data_assets ?? [],
    create_runtime,
  );
  const guest = await create_development_artifact_guest(
    game_id,
    active.revision,
    active.entry_wasm,
    active.entry_manifest_source,
    active.wasm_guest,
    options.data_assets ?? [],
  );
  const session = await create_runtime_session({
    guest,
    codec: blot_runtime_codec,
    observer: options.observer,
  });
  return Object.freeze({
    session,
    active_revision() {
      return active.revision;
    },
    async activate(
      next_descriptor: unknown,
      next_artifacts: BlotDevelopmentArtifactLoader,
    ) {
      const next = parse_blot_development_revision(next_descriptor);
      if (next.revision === active.revision) {
        return Object.freeze({
          revision: active.revision,
          entry_retained: true,
          state_preserved: true,
        });
      }
      if (can_activate_delta(active, next)) {
        const delta = await materialize_blot_development_delta(
          next,
          next_artifacts,
        );
        let activation: DevelopmentActivation | undefined;
        try {
          activation = await active.runtime.prepareActivation(delta);
          const replacement = await create_development_artifact_guest(
            game_id,
            next.revision,
            active.entry_wasm,
            active.entry_manifest_source,
            active.wasm_guest,
            options.data_assets ?? [],
          );
          const reloaded = await session.reload(replacement);
          active.runtime.commitActivation(activation);
          activation = undefined;
          active = Object.freeze({ ...active, revision: next.revision });
          return Object.freeze({
            revision: next.revision,
            entry_retained: true,
            state_preserved: reloaded.preserved,
          });
        } catch (error) {
          if (activation !== undefined) {
            active.runtime.abortActivation(activation);
          }
          throw error;
        }
      }

      const next_snapshot = await materialize_blot_development_snapshot(
        next,
        next_artifacts,
      );
      const candidate = await instantiate_development_runtime(
        next,
        next_snapshot,
        options.data_assets ?? [],
        create_runtime,
      );
      const replacement = await create_development_artifact_guest(
        game_id,
        candidate.revision,
        candidate.entry_wasm,
        candidate.entry_manifest_source,
        candidate.wasm_guest,
        options.data_assets ?? [],
      );
      const reloaded = await session.reload(replacement);
      active = candidate;
      return Object.freeze({
        revision: candidate.revision,
        entry_retained: false,
        state_preserved: reloaded.preserved,
      });
    },
  });
}

function can_activate_delta(
  active: ActiveBlotDevelopmentRuntime,
  next: ParsedBlotDevelopmentRevision,
): boolean {
  if (next.delta.base_revision !== active.runtime.revision) return false;
  if (next.entry_unit !== active.entry_unit) return false;
  if (next.delta.removed_units.includes(active.entry_unit)) return false;
  return !next.delta.changed_units.some(({ name }) =>
    name === active.entry_unit
  );
}

async function instantiate_development_runtime(
  revision: ParsedBlotDevelopmentRevision,
  build: DevelopmentBuild,
  data_assets: readonly BlotIntegerDataAsset[],
  create_runtime: DevelopmentRuntimeFactory,
): Promise<ActiveBlotDevelopmentRuntime> {
  const entry = build.changedUnits.find(({ name }) =>
    name === revision.entry_unit
  );
  if (entry === undefined) {
    throw new Error(
      `Blot development snapshot ${
        JSON.stringify(revision.revision)
      } omitted entry artifact ${JSON.stringify(revision.entry_unit)}`,
    );
  }
  const entry_manifest_source = new TextDecoder("utf-8", { fatal: true })
    .decode(entry.manifestBytes);
  const manifest = parse_blot_manifest(entry_manifest_source);
  const imports_ready = Promise.withResolvers<WebAssembly.Imports>();
  const instance_ready = Promise.withResolvers<WebAssembly.Instance>();
  let instantiation_requested = false;
  const guest_promise = create_blot_guest(
    entry.wasm,
    manifest,
    data_assets,
    {
      instantiate(_module, imports) {
        instantiation_requested = true;
        imports_ready.resolve(imports);
        return instance_ready.promise;
      },
    },
  );
  const guest_failed = new Promise<never>((_resolve, reject) => {
    guest_promise.catch(reject);
  });
  let runtime: DevelopmentRuntime | undefined;
  let activation: DevelopmentActivation | undefined;
  try {
    const entry_imports = await Promise.race([
      imports_ready.promise,
      guest_failed,
    ]);
    runtime = create_runtime(({ unit }) =>
      unit === revision.entry_unit ? entry_imports : {}
    );
    activation = await runtime.prepareActivation(build);
    runtime.commitActivation(activation);
    activation = undefined;
    instance_ready.resolve(runtime.entryInstance);
    const wasm_guest = await guest_promise;
    return Object.freeze({
      revision: revision.revision,
      entry_unit: revision.entry_unit,
      entry_wasm: new Uint8Array(entry.wasm),
      entry_manifest_source,
      runtime,
      wasm_guest,
    });
  } catch (error) {
    if (runtime !== undefined && activation !== undefined) {
      runtime.abortActivation(activation);
    }
    if (instantiation_requested) instance_ready.reject(error);
    await guest_promise.catch(() => undefined);
    throw error;
  }
}

async function create_development_artifact_guest(
  game_id: string,
  development_revision: string,
  entry_wasm: Uint8Array,
  entry_manifest_source: string,
  wasm_guest: GameGuest,
  data_assets: readonly BlotIntegerDataAsset[],
): Promise<BlotRuntimeGuest> {
  const manifest = parse_blot_manifest(entry_manifest_source);
  const [artifact_digest, schema_digest] = await Promise.all([
    digest_text(JSON.stringify({ development_revision, data_assets })),
    digest_text(JSON.stringify({
      guest_schema: game_schema_source(manifest, wasm_guest.state_schema),
      data_assets,
    })),
  ]);
  const artifact = parse_game_artifact({
    guest_id: game_id,
    artifact_digest,
    schema_digest,
    wasm: entry_wasm,
    capabilities: [],
  });
  return create_blot_runtime_guest({ artifact, wasm_guest });
}
