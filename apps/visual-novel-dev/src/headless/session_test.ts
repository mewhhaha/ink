import { build_blot_game } from "@ink/blot/build.ts";
import { asset_id } from "@ink/assets/identity.ts";
import { apply_narrative_command } from "@ink/narrative-editor/commands.ts";
import {
  narrative_beat_id,
  narrative_scene_id,
} from "@ink/narrative-editor/identity.ts";
import {
  parse_narrative_project,
  serialize_narrative_project,
} from "@ink/narrative-editor/serialization.ts";
import {
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { microseconds } from "@ink/runtime/session.ts";
import { vec2 } from "@ink/math/vector.ts";
import { headless_ui_snapshot } from "@ink/ui/headless.ts";
import { layout_ui } from "@ink/ui/layout.ts";
import type { LocalizationResolver } from "@ink/ui/localization.ts";
import {
  scenario_report_environment,
  write_scenario_assertion_report,
} from "../../../../scripts/scenario_report.ts";
import { signal_warning_beat } from "../contract.ts";
import { narrative_presentation } from "../presentation.ts";
import { compile_narrative_project } from "../project.ts";
import {
  finish_narrative_timeline,
  open_narrative_session,
  play_generated_narrative,
  required_action,
} from "./scenario.ts";

const viewport = { width: 960, height: 540 };
const application_directory = new URL("../../", import.meta.url);
const literal_resolver: LocalizationResolver = {
  resolve(id) {
    throw new Error(
      `narrative headless UI unexpectedly requested localization message ${
        JSON.stringify(id)
      }`,
    );
  },
};

Deno.test("the narrative guest presents authored beats in timeline order before choices", async () => {
  const session = await open_narrative_session();
  try {
    const initial = await session.observe(viewport);
    assertEquals(initial.observation.status.done, false);
    assertEquals(initial.observation.status.label, "The Last Station");
    const layout = layout_ui(initial.observation.ui, {
      viewport: vec2(viewport.width, viewport.height),
      player_scale: 1,
      reduced_motion: false,
    });
    if (layout.type === "rejected") {
      throw new Error(
        `headless narrative UI rejected ${layout.node}: ${layout.reason}`,
      );
    }
    const headless = headless_ui_snapshot(
      initial.observation.ui,
      layout.entries,
      literal_resolver,
    );
    assertEquals(
      headless.nodes.find(({ id }) => id === "narrative.speaker")?.label,
      "Mara",
    );
    assertEquals(
      headless.nodes.find(({ id }) => id === "narrative.dialogue")?.label,
      "Mara: The last train waits beneath a sky full of signals.",
    );
    assertEquals(
      narrative_presentation(initial).dialogue.text,
      [
        "Mara: The last train waits beneath a sky full of signals.",
      ].join("\n"),
    );
    assertEquals(narrative_presentation(initial).timeline, {
      elapsed_us: 500_000,
      duration_us: 1_000_000,
    });
    assertEquals(narrative_presentation(initial).choices, []);

    await session.advance({ elapsed_us: microseconds(500_000), inputs: [] });
    const second = await session.observe(viewport);
    assertStringIncludes(
      narrative_presentation(second).dialogue.text,
      "Station: The final service now boards from platform three.",
    );
    assertEquals(narrative_presentation(second).choices.map(({ id }) => id), [
      "follow-signal",
      "board-train",
    ]);

    await session.advance({
      elapsed_us: microseconds(0),
      inputs: [required_action(second, "follow-signal")],
    });
    const ending = await session.observe(viewport);
    assertEquals(ending.effects, [{
      type: "play_audio",
      id: "narrative.choice.follow-signal",
      cue: asset_id<"audio">("narrative.choice.follow-signal"),
    }]);
    assertEquals(ending.snapshot.camera, {
      type: "perspective",
      position: [0.2, 3.15, 8.8],
      target: [0, 1.35, 0],
      clear_color: [0.006, 0.009, 0.018],
      vertical_fov_radians: 0.72,
    });
    assertEquals(ending.snapshot.environment, {
      ambient_light: [0.09, 0.105, 0.16],
      fog_color: [0.018, 0.025, 0.055],
      fog_density: 0.016,
      exposure_ev100: 0.35,
      bloom_intensity: 0.3,
    });
    assertEquals(ending.snapshot.directional_light.color, [0.42, 0.68, 1]);
    assertEquals(ending.snapshot.objects.length, 4);
    assertEquals(ending.snapshot.objects[3].emissive, 7);
  } finally {
    await session.close();
  }
});

Deno.test("both choices reach distinct endings with evidence and replay parity", async () => {
  const [signal, ticket] = await play_generated_narrative();
  assertEquals(signal.ending, "The Answer");
  assertStringIncludes(signal.evidence, "Unfamiliar signal");
  assertStringIncludes(signal.dialogue, "forgotten call sign");
  const signal_evidence = signal.semantic_ui.nodes.find(({ id }) =>
    id === "narrative.evidence"
  );
  assertEquals(signal_evidence?.label, signal.evidence);
  assertEquals(signal_evidence?.rect === null, false);
  const signal_restart = signal.semantic_ui.nodes.find(({ id }) =>
    id === "narrative.restart"
  );
  assertEquals(signal_restart?.focusable, true);
  assertEquals(signal_restart?.label, "Restart story");
  assertEquals(signal_restart?.actions, [
    {
      id: "focus:narrative.restart",
      label: "Focus narrative.restart",
    },
    {
      id: "activate:narrative.restart",
      label: "Activate narrative.restart",
    },
  ]);
  assertEquals(signal.snapshot_checksum, signal.replay_checksum);
  assertEquals(ticket.ending, "A New Shore");
  assertStringIncludes(ticket.evidence, "Silver train ticket");
  assertStringIncludes(ticket.dialogue, "quiet harbor");
  assertEquals(
    ticket.semantic_ui.nodes.find(({ id }) => id === "narrative.evidence")
      ?.label,
    ticket.evidence,
  );
  assertEquals(ticket.snapshot_checksum, ticket.replay_checksum);
  assertNotEquals(signal.snapshot_checksum, ticket.snapshot_checksum);
  const report_path = Deno.env.get(scenario_report_environment);
  if (report_path !== undefined) {
    await write_scenario_assertion_report([{
      id: "headless:both-endings-have-replay-parity",
      status: "passed",
    }], report_path);
  }
});

Deno.test("adding a beat and rebuilding makes the new dialogue authoritative", async () => {
  const starter_source = await Deno.readTextFile(
    new URL("../../projects/starter.json", import.meta.url),
  );
  const edited = apply_narrative_command(
    parse_narrative_project(starter_source),
    {
      type: "add_beat",
      scene_id: narrative_scene_id("station"),
      beat: {
        ...signal_warning_beat,
        id: narrative_beat_id(signal_warning_beat.id),
      },
    },
  );
  const compiled = compile_narrative_project(
    serialize_narrative_project(edited),
  );
  assertStringIncludes(compiled.blot_source, ".timeline_duration_us = 1500000");
  const temporary_directory = new URL(
    `${await Deno.makeTempDir({
      dir: application_directory.pathname,
      prefix: ".narrative-rebuild-",
    })}/`,
    "file:///",
  );
  try {
    await Deno.mkdir(new URL("src/blot/game/", temporary_directory), {
      recursive: true,
    });
    await Deno.mkdir(new URL("src/blot/generated/", temporary_directory), {
      recursive: true,
    });
    await Promise.all([
      Deno.copyFile(
        new URL("src/blot/game/main.blot", application_directory),
        new URL("src/blot/game/main.blot", temporary_directory),
      ),
      Deno.copyFile(
        new URL("src/blot/prelude.blot", application_directory),
        new URL("src/blot/prelude.blot", temporary_directory),
      ),
      Deno.writeTextFile(
        new URL("src/blot/generated/project.blot", temporary_directory),
        compiled.blot_source,
      ),
    ]);
    await build_blot_game({
      artifact_name: "edited_narrative",
      assets_directory: new URL("assets/", application_directory),
      compiler: new URL("../../../blot/src/cli.ts", application_directory),
      entrypoint: new URL("src/blot/game/main.blot", temporary_directory),
      public_directory: new URL("generated/", temporary_directory),
      working_directory: application_directory,
    });
    const session = await open_narrative_session(
      new URL("generated/", temporary_directory),
      "edited_narrative",
    );
    try {
      const presentation = await finish_narrative_timeline(
        session,
        await session.observe(viewport),
      );
      assertStringIncludes(
        narrative_presentation(presentation).dialogue.text,
        [
          "Station: Warning: the green signal does not belong to this line.",
          "Follow the station map past the final service tunnel before boarding.",
        ].join("\n"),
      );
      assertEquals(narrative_presentation(presentation).timeline, {
        elapsed_us: 1_500_000,
        duration_us: 1_500_000,
      });
      assertEquals(
        narrative_presentation(presentation).choices.map(({ id }) => id),
        ["follow-signal", "board-train"],
      );
    } finally {
      await session.close();
    }
  } finally {
    await Deno.remove(temporary_directory, { recursive: true });
  }
});
