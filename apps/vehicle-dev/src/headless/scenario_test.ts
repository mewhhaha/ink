import { build_blot_game } from "@ink/blot/build.ts";
import {
  parse_vehicle_project,
  serialize_vehicle_project,
} from "@ink/vehicle-editor/serialization.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  scenario_report_environment,
  write_scenario_assertion_report,
} from "../../../../scripts/scenario_report.ts";
import { append_finish_checkpoint } from "../edit.ts";
import { compile_vehicle_project } from "../project.ts";
import { create_vehicle_runtime } from "../runtime.ts";
import { play_vehicle_course, rendered_vehicle_object } from "./scenario.ts";

const application_directory = new URL("../../", import.meta.url);
const proof_id = "headless:edited-course-rejects-early-finish-and-replays";
const physics_proof_id = "headless:physics-blocks-finish-shortcut";

Deno.test("edited finish checkpoint drives the ordered course", async () => {
  const starter = parse_vehicle_project(
    await Deno.readTextFile(
      new URL("projects/starter.json", application_directory),
    ),
  );
  const edited = append_finish_checkpoint(starter);
  const compiled = compile_vehicle_project(serialize_vehicle_project(edited));
  assertStringIncludes(compiled.blot_source, ".checkpoint_count = 4;");
  assertStringIncludes(
    compiled.blot_source,
    '.fourth_waypoint_id = "finish-line";',
  );
  assertEquals(compiled.collision.shortcut.contacts, 1);
  assertEquals(compiled.collision.ordered_course, {
    type: "clear",
    legs: 4,
  });

  const temporary_directory = new URL(
    `${await Deno.makeTempDir({
      dir: application_directory.pathname,
      prefix: ".vehicle-rebuild-",
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
      artifact_name: "edited_vehicle",
      compiler: new URL("../../../blot/src/cli.ts", application_directory),
      entrypoint: new URL("src/blot/game/main.blot", temporary_directory),
      public_directory: new URL("generated/", temporary_directory),
      working_directory: application_directory,
    });

    const manifest_source = await Deno.readTextFile(
      new URL("generated/edited_vehicle.wasm.json", temporary_directory),
    );
    assertStringIncludes(manifest_source, '"capability": "EcsSchema"');
    assertStringIncludes(manifest_source, '"operation": "seed_indexed"');
    const runtime = await create_vehicle_runtime({
      wasm_bytes: await Deno.readFile(
        new URL("generated/edited_vehicle.wasm", temporary_directory),
      ),
      manifest_source,
    });
    try {
      const playthrough = await play_vehicle_course(runtime.session);
      assertEquals(playthrough.initial.observation.status, {
        done: false,
        label: "Storm Pass",
        value: "Next checkpoint-start · rejected finishes 0",
      });
      assertEquals(playthrough.initial.snapshot.camera, {
        type: "perspective",
        position: [8, 48, 66],
        target: [8, 0, 2],
        clear_color: [0.006, 0.012, 0.025],
        vertical_fov_radians: 0.78,
      });
      assertEquals(playthrough.initial.snapshot.environment, {
        ambient_light: [0.025, 0.045, 0.085],
        fog_color: [0.015, 0.03, 0.075],
        fog_density: 0.006,
        exposure_ev100: 0.2,
        bloom_intensity: 0.34,
      });
      assertEquals(playthrough.initial.snapshot.directional_light, {
        type: "directional_light",
        color: [0.72, 0.84, 1],
        direction: [-0.42, -1, -0.28],
        intensity: 1.45,
      });
      assertEquals(
        rendered_vehicle_object(playthrough.initial, 23).visible,
        true,
      );
      assertEquals(
        rendered_vehicle_object(playthrough.initial, 30).visible,
        false,
      );
      assertEquals(
        rendered_vehicle_object(playthrough.initial, 31).position,
        [3_000_000, 1_400_000, 6_500_000],
      );
      assertEquals(
        rendered_vehicle_object(playthrough.initial, 31).scale,
        [1_600_000, 4_000_000, 5_000_000],
      );
      assertStringIncludes(
        JSON.stringify(playthrough.initial.observation.ui),
        "speed limit 22",
      );

      assertEquals(
        playthrough.early_finish.observation.status.value,
        "Next checkpoint-start · rejected finishes 1",
      );
      assertEquals(
        playthrough.early_finish.effects[0]?.id,
        "vehicle.finish-rejected",
      );
      assertEquals(
        String(playthrough.early_finish.effects[0]?.cue),
        "vehicle.rejected.finish-line",
      );
      assertStringIncludes(
        JSON.stringify(playthrough.early_finish.observation.ui),
        "Shortcut barrier blocked direct finish",
      );
      assertStringIncludes(
        JSON.stringify(playthrough.early_finish.observation.ui),
        "Canonical collision contacts 1",
      );
      assertEquals(
        playthrough.start.observation.status.value,
        "Next checkpoint-ridge · rejected finishes 1",
      );
      assertEquals(
        playthrough.start.effects[0]?.cue,
        "vehicle.checkpoint.start",
      );
      assertEquals(
        playthrough.ridge.observation.status.value,
        "Next checkpoint-tunnel · rejected finishes 1",
      );
      assertEquals(
        playthrough.ridge.effects[0]?.cue,
        "vehicle.checkpoint.ridge",
      );
      assertEquals(
        playthrough.tunnel.observation.status.value,
        "Next checkpoint-finish-line · rejected finishes 1",
      );
      assertEquals(
        playthrough.tunnel.effects[0]?.cue,
        "vehicle.checkpoint.tunnel",
      );

      assertEquals(playthrough.completed.observation.status, {
        done: true,
        label: "Storm Pass",
        value: "Course complete · checkpoints 4 · rejected finishes 1",
      });
      assertEquals(playthrough.completed.observation.outcome, "won");
      assertEquals(playthrough.completed.observation.actions, []);
      assertEquals(
        rendered_vehicle_object(playthrough.completed, 30).visible,
        true,
      );
      assertEquals(
        playthrough.completed.effects[0]?.id,
        "vehicle.course-completed",
      );
      assertEquals(
        String(playthrough.completed.effects[0]?.cue),
        "vehicle.complete.storm-pass",
      );
      assertStringIncludes(
        JSON.stringify(playthrough.completed.observation.ui),
        "Finish accepted",
      );
      assertEquals(playthrough.replay_checksum, playthrough.snapshot_checksum);
      assertEquals(playthrough.replayed, playthrough.completed);

      runtime.observations.log.clear();
      for (let index = 0; index < 20; index += 1) {
        runtime.observations.observer.event("vehicle.test.evidence", {
          file_path: `/private/vehicle-${index}.blot`,
          game_text: `secret-${index}`,
          checkpoint: index,
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
      assert(!(debugger_entries.at(-1)?.message ?? "").includes("secret-19"));
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
      { id: physics_proof_id, status: "passed" },
    ], report_path);
  }
});
