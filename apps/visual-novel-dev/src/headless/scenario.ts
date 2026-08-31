import type {
  BlotPresentation,
  BlotRuntimeSession,
} from "@ink/blot/runtime.ts";
import {
  game_action_from_ui_event,
  type GameAction,
} from "@ink/blot/protocol.ts";
import { Observer } from "@ink/observability/observer.ts";
import { create_redacting_sink } from "@ink/observability/redaction.ts";
import { create_ring_buffer_sink } from "@ink/observability/sink.ts";
import { vec2 } from "@ink/math/vector.ts";
import { microseconds } from "@ink/runtime/session.ts";
import {
  headless_ui_snapshot,
  type HeadlessUiSnapshot,
} from "@ink/ui/headless.ts";
import { UiController } from "@ink/ui/controller.ts";
import { layout_ui } from "@ink/ui/layout.ts";
import type { LocalizationResolver } from "@ink/ui/localization.ts";
import { ui_id } from "@ink/ui/semantic.ts";
import {
  narrative_presentation,
  next_narrative_timeline_step,
} from "../presentation.ts";
import { create_narrative_session } from "../runtime.ts";

const viewport = { width: 960, height: 540 };

export interface NarrativeOutcome {
  readonly choice_id: string;
  readonly ending: string;
  readonly evidence: string;
  readonly dialogue: string;
  readonly semantic_ui: HeadlessUiSnapshot;
  readonly snapshot_checksum: string;
  readonly replay_checksum: string;
}

const literal_resolver: LocalizationResolver = {
  resolve(id) {
    throw new Error(
      `narrative headless UI unexpectedly requested localization message ${
        JSON.stringify(id)
      }`,
    );
  },
};

export async function play_generated_narrative(
  directory = new URL("../../generated/", import.meta.url),
  artifact_name = "narrative_development",
): Promise<readonly NarrativeOutcome[]> {
  const [wasm_bytes, manifest_source] = await Promise.all([
    Deno.readFile(new URL(`${artifact_name}.wasm`, directory)),
    Deno.readTextFile(new URL(`${artifact_name}.wasm.json`, directory)),
  ]);
  const first = await play_choice(wasm_bytes, manifest_source, "follow-signal");
  const second = await play_choice(wasm_bytes, manifest_source, "board-train");
  return Object.freeze([first, second]);
}

async function play_choice(
  wasm_bytes: Uint8Array,
  manifest_source: string,
  choice_id: string,
): Promise<NarrativeOutcome> {
  const session = await create_narrative_session(
    wasm_bytes,
    manifest_source,
    narrative_headless_observer(),
  );
  try {
    const initial = await finish_narrative_timeline(
      session,
      await session.observe(viewport),
    );
    const initial_layout = layout_ui(initial.observation.ui, {
      viewport: vec2(viewport.width, viewport.height),
      player_scale: 1,
      reduced_motion: false,
    });
    if (initial_layout.type === "rejected") {
      throw new Error(
        `narrative choice ${choice_id} headless UI rejected ${initial_layout.node}: ${initial_layout.reason}`,
      );
    }
    const controller = new UiController();
    controller.update(initial.observation.ui, initial_layout.entries);
    const activation = controller.dispatch({
      type: "activate",
      target: ui_id(`narrative.choice.${choice_id}`),
    }).find(({ type }) => type === "activated");
    const action = activation === undefined
      ? undefined
      : game_action_from_ui_event(initial.observation, activation);
    if (action === undefined) {
      throw new Error(
        `narrative choice ${choice_id} did not produce a headless activation action`,
      );
    }
    const revision = await session.advance({
      elapsed_us: microseconds(0),
      inputs: [action],
    });
    const ending = await session.observe(viewport);
    if (!ending.observation.status.done) {
      throw new Error(
        `narrative choice ${choice_id} did not reach an ending: ${ending.observation.status.value}`,
      );
    }
    const replay = await session.finish_replay();
    await session.reset();
    const replayed = await session.replay(replay);
    const replayed_ending = await session.observe(viewport);
    if (
      JSON.stringify(replayed_ending) !== JSON.stringify(ending)
    ) {
      throw new Error(
        `narrative choice ${choice_id} replay changed its presentation`,
      );
    }
    const ending_presentation = narrative_presentation(ending);
    const layout = layout_ui(ending.observation.ui, {
      viewport: vec2(viewport.width, viewport.height),
      player_scale: 1,
      reduced_motion: false,
    });
    if (layout.type === "rejected") {
      throw new Error(
        `narrative choice ${choice_id} headless UI rejected ${layout.node}: ${layout.reason}`,
      );
    }
    return Object.freeze({
      choice_id,
      ending: ending.observation.status.label,
      evidence: ending_presentation.evidence ?? "",
      dialogue: ending_presentation.dialogue.text,
      semantic_ui: headless_ui_snapshot(
        ending.observation.ui,
        layout.entries,
        literal_resolver,
      ),
      snapshot_checksum: revision.snapshot_checksum,
      replay_checksum: replayed.snapshot_checksum,
    });
  } finally {
    await session.close();
  }
}

export function required_action(
  presentation: BlotPresentation,
  id: string,
): GameAction {
  const choice = narrative_presentation(presentation).choices.find((choice) =>
    choice.id === id
  );
  if (choice === undefined) {
    throw new Error(`narrative action ${JSON.stringify(id)} is missing`);
  }
  return choice.action;
}

export async function finish_narrative_timeline(
  session: BlotRuntimeSession,
  initial: BlotPresentation,
): Promise<BlotPresentation> {
  let presentation = initial;
  for (let step = 0; step < 1_000; step += 1) {
    const elapsed_us = next_narrative_timeline_step(presentation);
    if (elapsed_us === undefined) return presentation;
    await session.advance({ elapsed_us, inputs: [] });
    presentation = await session.observe(viewport);
  }
  throw new Error("narrative timeline did not finish within 1,000 steps");
}

export async function open_narrative_session(
  directory = new URL("../../generated/", import.meta.url),
  artifact_name = "narrative_development",
): Promise<BlotRuntimeSession> {
  const [wasm_bytes, manifest_source] = await Promise.all([
    Deno.readFile(new URL(`${artifact_name}.wasm`, directory)),
    Deno.readTextFile(new URL(`${artifact_name}.wasm.json`, directory)),
  ]);
  return await create_narrative_session(
    wasm_bytes,
    manifest_source,
    narrative_headless_observer(),
  );
}

function narrative_headless_observer(): Observer {
  return new Observer({
    source: { subsystem: "narrative-headless" },
    sink: create_redacting_sink(create_ring_buffer_sink(100)),
    clock: { now_seconds: () => performance.now() / 1_000 },
  });
}
