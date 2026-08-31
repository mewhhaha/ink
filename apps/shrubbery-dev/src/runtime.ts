import {
  blot,
  type BlotDevelopmentRuntimeSession,
  create_blot_development_session,
} from "@ink/blot/adapter.ts";
import type {
  BlotPresentation,
  BlotRuntimeSession,
} from "@ink/blot/runtime.ts";
import type { GameAction, RenderSnapshot } from "@ink/blot/protocol.ts";
import type { Observer } from "@ink/observability/observer.ts";
import type { LocalizationResolver } from "@ink/ui/localization.ts";
import { require_ui_text } from "@ink/ui/localization.ts";

export interface ShrubberyObservation {
  readonly actions: readonly {
    readonly id: string;
    readonly label: string;
    readonly action: GameAction;
  }[];
  readonly selected_name: string;
  readonly snapshot: RenderSnapshot;
}

const shrubbery_adapter = blot({ game_id: "shrubbery" });
const literal_resolver: LocalizationResolver = {
  resolve(id) {
    throw new Error(
      `shrubbery UI unexpectedly requested localization message ${
        JSON.stringify(id)
      }`,
    );
  },
};

export async function create_shrubbery_session(
  wasm_bytes: Uint8Array,
  manifest_source: string,
  observer: Observer,
): Promise<BlotRuntimeSession> {
  return await shrubbery_adapter.create_session(wasm_bytes, manifest_source, {
    observer,
  });
}

export async function create_shrubbery_development_session(
  revision_descriptor: unknown,
  artifacts: { load(path: string): Promise<Uint8Array> },
  runtime_module: unknown,
  observer: Observer,
): Promise<BlotDevelopmentRuntimeSession> {
  return await create_blot_development_session(
    shrubbery_adapter.configuration,
    revision_descriptor,
    artifacts,
    runtime_module,
    { observer },
  );
}

export function shrubbery_observation(
  presentation: BlotPresentation,
): ShrubberyObservation {
  return {
    actions: presentation.observation.actions.map(({ action, id, label }) => ({
      action,
      id,
      label: require_ui_text(label, literal_resolver),
    })),
    selected_name: presentation.observation.status.label,
    snapshot: presentation.snapshot,
  };
}
