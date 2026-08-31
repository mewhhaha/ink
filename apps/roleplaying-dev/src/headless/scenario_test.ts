import { build_blot_game } from "@ink/blot/build.ts";
import {
  parse_roleplaying_project,
  serialize_roleplaying_project,
} from "@ink/roleplaying-editor/serialization.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  scenario_report_environment,
  write_scenario_assertion_report,
} from "../../../../scripts/scenario_report.ts";
import { add_roleplaying_loot_entry } from "../edit.ts";
import { compile_roleplaying_project } from "../project.ts";
import { create_roleplaying_runtime } from "../runtime.ts";
import {
  play_roleplaying_to_shrine,
  probe_roleplaying_timeline_guards,
  rendered_roleplaying_object,
} from "./scenario.ts";

const application_directory = new URL("../../", import.meta.url);
const proof_id =
  "headless:edited-ruins-pilgrimage-replay-and-presentation-parity";
const timeline_proof_id =
  "headless:authored-timeline-rejects-out-of-order-and-early-actions";

Deno.test("edited ruins loot drives the deterministic shrine pilgrimage", async () => {
  const starter = parse_roleplaying_project(
    await Deno.readTextFile(
      new URL("projects/starter.json", application_directory),
    ),
  );
  const edited = add_roleplaying_loot_entry(
    starter,
    "ruins-cache",
    "moonstone-relic",
  );
  const compiled = compile_roleplaying_project(
    serialize_roleplaying_project(edited),
  );
  assertStringIncludes(
    compiled.blot_source,
    '.loot_entry = "moonstone-relic";',
  );
  assertStringIncludes(
    compiled.blot_source,
    ".dialogue_beat_time_us = 250000;",
  );
  assertStringIncludes(compiled.blot_source, ".quest_beat_time_us = 1500000;");

  const temporary_directory = new URL(
    `${await Deno.makeTempDir({
      dir: application_directory.pathname,
      prefix: ".roleplaying-rebuild-",
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
      artifact_name: "edited_roleplaying",
      compiler: new URL("../../../blot/src/cli.ts", application_directory),
      entrypoint: new URL("src/blot/game/main.blot", temporary_directory),
      public_directory: new URL("generated/", temporary_directory),
      working_directory: application_directory,
    });

    const runtime = await create_roleplaying_runtime({
      wasm_bytes: await Deno.readFile(
        new URL("generated/edited_roleplaying.wasm", temporary_directory),
      ),
      manifest_source: await Deno.readTextFile(
        new URL(
          "generated/edited_roleplaying.wasm.json",
          temporary_directory,
        ),
      ),
    });
    try {
      const guards = await probe_roleplaying_timeline_guards(runtime.session);
      assertEquals(guards.out_of_order.observation.status, {
        done: false,
        label: "Keeper's Village",
        value: "Village Keeper waits by the ruins road",
      });
      assertEquals(guards.out_of_order.effects, []);
      assertEquals(guards.too_early.observation.status, {
        done: false,
        label: "Keeper's Village",
        value: "Village Keeper waits by the ruins road",
      });
      assertEquals(guards.too_early.effects, []);
      assertEquals(
        guards.on_time.observation.status.value,
        "Travel to Old Ruins",
      );
      assertEquals(
        guards.on_time.effects[0]?.cue,
        "roleplaying.keeper-greeting",
      );

      const playthrough = await play_roleplaying_to_shrine(runtime.session);
      assertEquals(playthrough.initial.observation.status, {
        done: false,
        label: "Keeper's Village",
        value: "Village Keeper waits by the ruins road",
      });
      assertEquals(playthrough.initial.snapshot.camera, {
        type: "perspective",
        position: [0, 4, 8],
        target: [0, 1, 0],
        clear_color: [0.008, 0.01, 0.018],
        vertical_fov_radians: 0.72,
      });
      assertEquals(playthrough.initial.snapshot.environment, {
        ambient_light: [0.035, 0.04, 0.065],
        fog_color: [0.012, 0.016, 0.03],
        fog_density: 0.018,
        exposure_ev100: -0.25,
        bloom_intensity: 0.24,
      });
      assertEquals(
        rendered_roleplaying_object(playthrough.initial, 11).visible,
        true,
      );
      assertEquals(
        playthrough.initial.observation.actions.some(({ id }) =>
          id === "activate:roleplaying.travel-ruins"
        ),
        false,
      );
      assert(
        !JSON.stringify(playthrough.initial.observation.ui).includes(
          "The ruins have awakened",
        ),
      );

      assertEquals(
        playthrough.talked.observation.status.value,
        "Travel to Old Ruins",
      );
      assertStringIncludes(
        JSON.stringify(playthrough.talked.observation.ui),
        "The ruins have awakened. Carry their relic to the shrine.",
      );
      assertEquals(playthrough.talked.effects.length, 1);
      assertEquals(playthrough.talked.effects[0]?.type, "play_audio");
      assertEquals(playthrough.talked.effects[0]?.id, "roleplaying.talk");
      assertEquals(
        playthrough.talked.effects[0]?.cue,
        "roleplaying.keeper-greeting",
      );
      assertEquals(
        playthrough.arrived_at_ruins.observation.status.value,
        "Ruins Sentinel health 4",
      );
      assertEquals(
        rendered_roleplaying_object(playthrough.arrived_at_ruins, 12).visible,
        true,
      );

      assertEquals(
        playthrough.first_strike.observation.status.value,
        "Ruins Sentinel health 2",
      );
      assertEquals(
        playthrough.first_strike.effects[0]?.id,
        "roleplaying.strike",
      );
      assertEquals(playthrough.sentinel_defeated.observation.status, {
        done: false,
        label: "Sentinel defeated",
        value: "Collect moonstone-relic",
      });
      assertEquals(
        rendered_roleplaying_object(playthrough.sentinel_defeated, 12).visible,
        false,
      );
      assertEquals(
        rendered_roleplaying_object(playthrough.sentinel_defeated, 13).visible,
        true,
      );

      assertEquals(playthrough.loot_collected.observation.status, {
        done: false,
        label: "Old Ruins",
        value: "moonstone-relic secured for Sunken Shrine",
      });
      assertEquals(
        playthrough.loot_collected.effects[0]?.cue,
        "roleplaying.ruins-cache",
      );
      assertEquals(playthrough.completed.observation.status, {
        done: true,
        label: "The Sentinel Road",
        value: "moonstone-relic offered at Sunken Shrine",
      });
      assertStringIncludes(
        JSON.stringify(playthrough.completed.observation.ui),
        "moonstone-relic offered at Sunken Shrine",
      );
      assertEquals(
        rendered_roleplaying_object(playthrough.completed, 14).visible,
        true,
      );
      assertEquals(playthrough.replay_checksum, playthrough.snapshot_checksum);
      assertEquals(playthrough.replayed, playthrough.completed);

      runtime.observations.log.clear();
      for (let index = 0; index < 20; index += 1) {
        runtime.observations.observer.event("roleplaying.test.evidence", {
          file_path: `/private/roleplaying-${index}.blot`,
          game_text: `secret-${index}`,
          frame: index,
        });
      }
      assertEquals(runtime.observations.log.capacity, 16);
      assertEquals(runtime.observations.log.observations().length, 16);
      assertEquals(runtime.observations.log.dropped(), 4);
      assertEquals(runtime.observations.log.failures(), []);
      const retained = runtime.observations.log.observations().at(-1);
      assertEquals(
        retained?.type === "event" ? retained.evidence.file_path : undefined,
        "[redacted]",
      );
      assertEquals(
        retained?.type === "event" ? retained.evidence.game_text : undefined,
        "[redacted]",
      );
      const debugger_entries = runtime.observations.debugger_entries();
      assertEquals(debugger_entries.length, 16);
      assertStringIncludes(
        debugger_entries.at(-1)?.message ?? "",
        "[redacted]",
      );
      assert(
        !(debugger_entries.at(-1)?.message ?? "").includes("secret-19"),
      );
    } finally {
      await runtime.session.close();
    }
  } finally {
    await Deno.remove(temporary_directory, { recursive: true });
  }

  const report_path = Deno.env.get(scenario_report_environment);
  if (report_path !== undefined) {
    await write_scenario_assertion_report([
      { id: proof_id, status: "passed" },
      { id: timeline_proof_id, status: "passed" },
    ], report_path);
  }
});
