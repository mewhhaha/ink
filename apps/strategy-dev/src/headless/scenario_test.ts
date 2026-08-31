import { build_blot_game } from "@ink/blot/build.ts";
import { create_strategy_starter } from "@ink/strategy-editor/presets.ts";
import { serialize_strategy_project } from "@ink/strategy-editor/serialization.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  scenario_report_environment,
  write_scenario_assertion_report,
} from "../../../../scripts/scenario_report.ts";
import { add_player_barracks_and_scout_route } from "../edit.ts";
import { compile_strategy_project } from "../project.ts";
import { create_strategy_runtime } from "../runtime.ts";
import {
  play_strategy_to_victory,
  rendered_strategy_object,
} from "./scenario.ts";

const application_directory = new URL("../../", import.meta.url);
const proof_id =
  "headless:edited-barracks-route-drives-ordered-victory-and-replay";

Deno.test("edited barracks and route drive the deterministic headquarters assault", async () => {
  const starter = create_strategy_starter("real-time-strategy");
  const edited = add_player_barracks_and_scout_route(starter);
  const compiled = compile_strategy_project(
    serialize_strategy_project(edited),
  );
  assertEquals(compiled.content.has_barracks, true);
  assertEquals(compiled.content.route.map(({ order }) => order), [1, 2, 3, 4]);
  assertStringIncludes(
    compiled.blot_source,
    '.barracks_id = "scout-barracks";',
  );
  assertStringIncludes(compiled.blot_source, '.id = "scout-route-point-4";');

  const temporary_directory = new URL(
    `${await Deno.makeTempDir({
      dir: application_directory.pathname,
      prefix: ".strategy-rebuild-",
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
      artifact_name: "edited_strategy",
      compiler: new URL("../../../blot/src/cli.ts", application_directory),
      entrypoint: new URL("src/blot/game/main.blot", temporary_directory),
      public_directory: new URL("generated/", temporary_directory),
      working_directory: application_directory,
    });

    const runtime = await create_strategy_runtime({
      wasm_bytes: await Deno.readFile(
        new URL("generated/edited_strategy.wasm", temporary_directory),
      ),
      manifest_source: await Deno.readTextFile(
        new URL("generated/edited_strategy.wasm.json", temporary_directory),
      ),
    });
    try {
      const playthrough = await play_strategy_to_victory(runtime.session);
      assertEquals(playthrough.initial.observation.status, {
        done: false,
        label: "Real-time Strategy Starter",
        value: "Train 3 scouts, follow every waypoint, then attack",
      });
      assertEquals(playthrough.initial.snapshot.camera, {
        type: "perspective",
        position: [12, 31, 37],
        target: [12, 0, 8],
        clear_color: [0.008, 0.016, 0.012],
        vertical_fov_radians: 0.72,
      });
      assertEquals(playthrough.initial.snapshot.environment, {
        ambient_light: [0.025, 0.055, 0.035],
        fog_color: [0.02, 0.045, 0.032],
        fog_density: 0.004,
        exposure_ev100: 0.15,
        bloom_intensity: 0.28,
      });
      assertEquals(playthrough.initial.snapshot.directional_light, {
        type: "directional_light",
        color: [1, 0.86, 0.68],
        direction: [-0.42, -1, -0.28],
        intensity: 1.45,
      });
      assertEquals(
        rendered_strategy_object(playthrough.initial, 12).visible,
        true,
      );
      assertEquals(
        rendered_strategy_object(playthrough.initial, 30).visible,
        false,
      );
      assert(playthrough.initial.snapshot.objects.length > 40);
      assertStringIncludes(
        JSON.stringify(playthrough.initial.observation.ui),
        "Generated world frontier-assault",
      );

      assertEquals(
        playthrough.early_attack.observation.status.value,
        "Attack rejected · train 3 scouts and finish the route",
      );
      assertEquals(playthrough.early_attack.effects.length, 1);
      assertEquals(
        playthrough.early_attack.effects[0]?.id,
        "strategy.attack-rejected",
      );
      assertEquals(
        String(playthrough.early_attack.effects[0]?.cue),
        "strategy.attack.rejected",
      );
      assertEquals(
        playthrough.trained.map(({ observation }) => observation.status.value),
        [
          "Scout trained · force size 1",
          "Scout trained · force size 2",
          "Scout trained · force size 3",
        ],
      );
      assertEquals(
        playthrough.trained.map(({ effects }) => effects[0]?.cue),
        [
          "strategy.train.scout",
          "strategy.train.scout",
          "strategy.train.scout",
        ],
      );

      assertEquals(
        playthrough.route.map(({ observation }) => observation.status.value),
        [
          "Waypoint reached 1 of 4",
          "Waypoint reached 2 of 4",
          "Waypoint reached 3 of 4",
          "Waypoint reached 4 of 4",
        ],
      );
      assertEquals(
        playthrough.route.map(({ effects }) => effects[0]?.cue),
        [
          "strategy.route.scout-route-point-1",
          "strategy.route.scout-route-point-2",
          "strategy.route.scout-route-point-3",
          "strategy.route.scout-route-point-4",
        ],
      );
      assertEquals(
        rendered_strategy_object(playthrough.route[3]!, 20).position,
        [22_000_000, 850_000, 8_000_000],
      );
      assertStringIncludes(
        JSON.stringify(playthrough.route[3]!.observation.ui),
        "Route travel 9 seconds",
      );
      assertEquals(
        playthrough.headquarters_hits.map(({ observation }) =>
          observation.status.value
        ),
        ["Headquarters health 2", "Headquarters health 1"],
      );
      assertEquals(playthrough.completed.observation.status, {
        done: true,
        label: "Real-time Strategy Starter",
        value: "Opposing headquarters destroyed · travel seconds 9",
      });
      assertEquals(playthrough.completed.observation.outcome, "won");
      assertEquals(
        playthrough.completed.observation.actions.map(({ id }) => id),
        ["focus:strategy.restart", "activate:strategy.restart"],
      );
      assertEquals(
        rendered_strategy_object(playthrough.completed, 11).visible,
        false,
      );
      assertEquals(
        rendered_strategy_object(playthrough.completed, 30).visible,
        true,
      );
      assertEquals(playthrough.completed.effects.length, 1);
      assertEquals(
        playthrough.completed.effects[0]?.id,
        "strategy.headquarters-destroyed",
      );
      assertEquals(
        String(playthrough.completed.effects[0]?.cue),
        "strategy.complete.destroy-headquarters",
      );
      assertEquals(playthrough.replay_checksum, playthrough.snapshot_checksum);
      assertEquals(playthrough.replayed, playthrough.completed);

      runtime.observations.log.clear();
      for (let index = 0; index < 28; index += 1) {
        runtime.observations.observer.event("strategy.test.evidence", {
          file_path: `/private/strategy-${index}.blot`,
          game_text: `secret-${index}`,
          route_point: index,
        });
      }
      assertEquals(runtime.observations.log.capacity, 24);
      assertEquals(runtime.observations.log.observations().length, 24);
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
      const debugger_entry = runtime.observations.debugger_entries().at(-1);
      assertStringIncludes(debugger_entry?.message ?? "", "[redacted]");
      assert(!(debugger_entry?.message ?? "").includes("secret-27"));
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
