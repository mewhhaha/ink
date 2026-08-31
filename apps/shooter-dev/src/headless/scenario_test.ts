import { build_blot_game } from "@ink/blot/build.ts";
import {
  parse_shooter_project,
  serialize_shooter_project,
} from "@ink/shooter-editor/serialization.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  scenario_report_environment,
  write_scenario_assertion_report,
} from "../../../../scripts/scenario_report.ts";
import { add_first_contact_reinforcement } from "../edit.ts";
import { compile_shooter_project } from "../project.ts";
import { create_shooter_runtime } from "../runtime.ts";
import { play_shooter_to_clear, rendered_shooter_object } from "./scenario.ts";

const application_directory = new URL("../../", import.meta.url);
const proof_id =
  "headless:edited-reinforcement-arena-replay-and-presentation-parity";

Deno.test("edited reinforcement drives the deterministic two-enemy arena", async () => {
  const starter = parse_shooter_project(
    await Deno.readTextFile(
      new URL("projects/starter.json", application_directory),
    ),
  );
  const edited = add_first_contact_reinforcement(starter);
  const compiled = compile_shooter_project(
    serialize_shooter_project(edited),
  );
  assertStringIncludes(compiled.blot_source, ".enemy_count = 2;");
  assertStringIncludes(
    compiled.blot_source,
    '.second_enemy_id = "reinforcement";',
  );

  const temporary_directory = new URL(
    `${await Deno.makeTempDir({
      dir: application_directory.pathname,
      prefix: ".shooter-rebuild-",
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
      artifact_name: "edited_shooter",
      compiler: new URL("../../../blot/src/cli.ts", application_directory),
      entrypoint: new URL("src/blot/game/main.blot", temporary_directory),
      public_directory: new URL("generated/", temporary_directory),
      working_directory: application_directory,
    });

    const manifest_source = await Deno.readTextFile(
      new URL("generated/edited_shooter.wasm.json", temporary_directory),
    );
    assertStringIncludes(manifest_source, '"capability": "EcsSchema"');
    assertStringIncludes(manifest_source, '"operation": "seed_indexed"');
    const runtime = await create_shooter_runtime({
      wasm_bytes: await Deno.readFile(
        new URL("generated/edited_shooter.wasm", temporary_directory),
      ),
      manifest_source,
    });
    try {
      const playthrough = await play_shooter_to_clear(runtime.session);
      assertEquals(playthrough.initial.observation.status, {
        done: false,
        label: "Arena",
        value: "guard health 40 · rounds 12",
      });
      assertEquals(playthrough.initial.snapshot.camera, {
        type: "perspective",
        position: [0, 4, 8],
        target: [0, 1, 0],
        clear_color: [0.006, 0.008, 0.014],
        vertical_fov_radians: 0.72,
      });
      assertEquals(playthrough.initial.snapshot.environment, {
        ambient_light: [0.025, 0.035, 0.06],
        fog_color: [0.008, 0.012, 0.024],
        fog_density: 0.012,
        exposure_ev100: -0.1,
        bloom_intensity: 0.28,
      });
      assertEquals(
        playthrough.initial.snapshot.directional_light,
        {
          type: "directional_light",
          color: [1, 0.78, 0.56],
          direction: [-0.35, -1, -0.22],
          intensity: 1.3,
        },
      );
      assertEquals(
        rendered_shooter_object(playthrough.initial, 12).visible,
        true,
      );
      assertEquals(
        rendered_shooter_object(playthrough.initial, 13).visible,
        false,
      );
      assertStringIncludes(
        JSON.stringify(playthrough.initial.observation.ui),
        "authored ammunition",
      );

      assertEquals(
        playthrough.guard_hit.observation.status.value,
        "guard health 20 · rounds 11",
      );
      assertEquals(playthrough.guard_hit.effects.length, 1);
      assertEquals(playthrough.guard_hit.effects[0]?.type, "play_audio");
      assertEquals(playthrough.guard_hit.effects[0]?.id, "shooter.fire");
      assertEquals(
        playthrough.guard_hit.effects[0] === undefined
          ? undefined
          : String(playthrough.guard_hit.effects[0].cue),
        "shooter.fire.sidearm",
      );
      assertEquals(
        playthrough.reinforcement_arrived.observation.status.value,
        "reinforcement health 40 · rounds 10",
      );
      assertEquals(
        playthrough.reinforcement_arrived.effects[0]?.id,
        "shooter.reinforcement-arrived",
      );
      assertEquals(
        playthrough.reinforcement_arrived.effects[0]?.cue,
        "shooter.reinforcement.reinforcement",
      );
      assertEquals(
        rendered_shooter_object(playthrough.reinforcement_arrived, 12).visible,
        false,
      );
      assertEquals(
        rendered_shooter_object(playthrough.reinforcement_arrived, 13).visible,
        true,
      );
      assertEquals(
        playthrough.reinforcement_hit.observation.status.value,
        "reinforcement health 20 · rounds 9",
      );
      assertEquals(playthrough.completed.observation.status, {
        done: true,
        label: "First Contact",
        value: "Arena cleared · rounds remaining 8 · enemies defeated 2",
      });
      assertEquals(playthrough.completed.observation.outcome, "won");
      assertEquals(playthrough.completed.observation.actions, []);
      assertEquals(
        rendered_shooter_object(playthrough.completed, 13).visible,
        false,
      );
      assertEquals(
        rendered_shooter_object(playthrough.completed, 14).visible,
        true,
      );
      assertStringIncludes(
        JSON.stringify(playthrough.completed.observation.ui),
        "clear-arena completed",
      );
      assertEquals(playthrough.completed.effects.length, 1);
      assertEquals(
        playthrough.completed.effects[0]?.id,
        "shooter.arena-cleared",
      );
      assertEquals(
        playthrough.completed.effects[0] === undefined
          ? undefined
          : String(playthrough.completed.effects[0].cue),
        "shooter.complete.clear-arena",
      );
      assertEquals(playthrough.replay_checksum, playthrough.snapshot_checksum);
      assertEquals(playthrough.replayed, playthrough.completed);

      runtime.observations.log.clear();
      for (let index = 0; index < 20; index += 1) {
        runtime.observations.observer.event("shooter.test.evidence", {
          file_path: `/private/shooter-${index}.blot`,
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
    await write_scenario_assertion_report([{
      id: proof_id,
      status: "passed",
    }], report_path);
  }
});
