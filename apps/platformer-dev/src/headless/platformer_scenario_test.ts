import { build_blot_game } from "@ink/blot/build.ts";
import { vec2 } from "@ink/math/vector.ts";
import { move_platformer_record } from "@ink/platformer-editor/commands.ts";
import {
  platformer_level_id,
  platformer_record_id,
} from "@ink/platformer-editor/identity.ts";
import {
  parse_platformer_project,
  serialize_platformer_project,
} from "@ink/platformer-editor/serialization.ts";
import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertStringIncludes,
} from "@std/assert";
import { decode_input_frame } from "@ink/input/recording.ts";
import { action_id } from "@ink/input/model.ts";
import {
  scenario_report_environment,
  write_scenario_assertion_report,
} from "../../../../scripts/scenario_report.ts";
import { create_platformer_collision_oracle } from "../collision_oracle.ts";
import { platformer_player_animation } from "../animation.ts";
import { load_platformer_level_asset } from "../assets.ts";
import { compile_platformer_project } from "../project.ts";
import { platformer_render_scene } from "../rendering.ts";
import { create_platformer_runtime } from "../runtime.ts";
import {
  play_platformer_to_exit,
  rendered_platformer_object,
} from "./scenario.ts";

const application_directory = new URL("../../", import.meta.url);

Deno.test("moving the authored exit rebuilds deterministic platformer play", async () => {
  const starter_source = await Deno.readTextFile(
    new URL("projects/starter.json", application_directory),
  );
  const starter = parse_platformer_project(starter_source);
  const edited = move_platformer_record(
    starter,
    platformer_level_id("first-steps"),
    platformer_record_id("level-exit"),
    { x: 1, y: 0 },
  );
  const compiled = compile_platformer_project(
    serialize_platformer_project(edited),
  );
  assertStringIncludes(compiled.blot_source, ".exit_min_x = 29000000;");
  assertStringIncludes(compiled.blot_source, ".exit_max_x = 32000000;");

  const temporary_directory = new URL(
    `${await Deno.makeTempDir({
      dir: application_directory.pathname,
      prefix: ".platformer-rebuild-",
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
      artifact_name: "edited_platformer",
      compiler: new URL("../../../blot/src/cli.ts", application_directory),
      entrypoint: new URL("src/blot/game/main.blot", temporary_directory),
      generated_assets: [{
        id: "levels/first-steps.json",
        kind: "json",
        bytes: new TextEncoder().encode(compiled.level_asset_source),
      }],
      public_directory: new URL("generated/", temporary_directory),
      working_directory: application_directory,
    });

    const generated_directory = new URL("generated/", temporary_directory);
    const level_source = await load_platformer_level_asset({
      name: new URL("assets.manifest.json", generated_directory).href,
      read_manifest() {
        return Deno.readTextFile(
          new URL("assets.manifest.json", generated_directory),
        );
      },
      artifacts: {
        read(location) {
          return Deno.readFile(new URL(location, generated_directory));
        },
      },
    });
    const runtime = await create_platformer_runtime({
      wasm_bytes: await Deno.readFile(
        new URL("generated/edited_platformer.wasm", temporary_directory),
      ),
      manifest_source: await Deno.readTextFile(
        new URL("generated/edited_platformer.wasm.json", temporary_directory),
      ),
      level_source,
    });
    try {
      const playthrough = await play_platformer_to_exit(runtime.session);
      assertEquals(playthrough.initial.observation.status, {
        done: false,
        label: "First steps",
        value: "Run and jump to the exit",
      });
      const initial_player = rendered_platformer_object(
        playthrough.initial,
        10,
      );
      assertEquals(playthrough.initial.snapshot.camera, {
        type: "orthographic",
        position: [
          initial_player.position[0] / 1_000_000,
          initial_player.position[1] / 1_000_000,
          20,
        ],
        target: [
          initial_player.position[0] / 1_000_000,
          initial_player.position[1] / 1_000_000,
          0,
        ],
        clear_color: [0.012, 0.018, 0.038],
        vertical_size: 12,
      });
      assertEquals(playthrough.initial.snapshot.environment, {
        ambient_light: [0.18, 0.22, 0.3],
        fog_color: [0.012, 0.018, 0.038],
        fog_density: 0.004,
        exposure_ev100: 0.65,
        bloom_intensity: 0.22,
      });
      assertEquals(
        rendered_platformer_object(playthrough.initial, 11).position[0],
        30_500_000,
      );
      assertEquals(playthrough.before_jump.observation.status.done, false);
      const grounded_player = rendered_platformer_object(
        playthrough.before_jump,
        10,
      );
      assertEquals(grounded_player.position, [
        28_240_000,
        2_750_000,
        200_000,
      ]);
      const grounded_animation = platformer_player_animation(
        playthrough.before_jump.snapshot,
      );
      assertEquals(grounded_animation.sample_time, 0);
      assertEquals(grounded_animation.position_offset, [0, 0, 0]);
      assertEquals(grounded_animation.scale, [1, 1, 1]);
      const original_oracle = create_platformer_collision_oracle(
        starter,
        runtime.observations.observer,
      );
      const edited_oracle = create_platformer_collision_oracle(
        edited,
        runtime.observations.observer,
      );
      const grounded_center = vec2(
        grounded_player.position[0] / 1_000_000,
        grounded_player.position[1] / 1_000_000,
      );
      assertEquals(
        original_oracle.player_overlaps_exit(grounded_center),
        true,
      );
      assertEquals(
        edited_oracle.player_overlaps_exit(grounded_center),
        false,
      );
      assertEquals(edited_oracle.support_distance(grounded_center, 0.1), 0);

      assertEquals(
        playthrough.airborne.observation.status.value,
        "Jumping to the exit",
      );
      assertEquals(playthrough.airborne.observation.status.done, false);
      assert(
        rendered_platformer_object(playthrough.airborne, 10).position[1] >
          2_750_000,
      );
      const airborne_player = rendered_platformer_object(
        playthrough.airborne,
        10,
      );
      assertEquals(playthrough.airborne.snapshot.camera.target, [
        airborne_player.position[0] / 1_000_000,
        airborne_player.position[1] / 1_000_000,
        0,
      ]);
      const airborne_animation = platformer_player_animation(
        playthrough.airborne.snapshot,
      );
      assert(airborne_animation.sample_time > 0);
      assert(airborne_animation.sample_time < 1);
      assert(airborne_animation.position_offset[1] > 0);
      assert(airborne_animation.rotation_z_radians < 0);
      const airborne_scene = platformer_render_scene(
        playthrough.airborne.snapshot,
        playthrough.airborne.observation.sequence,
      );
      const airborne_rendered_player = airborne_scene.hierarchy.nodes.find(
        ({ id }) => id.index === 10,
      );
      assert(airborne_rendered_player !== undefined);
      assert(
        airborne_rendered_player.local_transform.position.y >
          rendered_platformer_object(playthrough.airborne, 10).position[1] /
            1_000_000,
      );
      assert(
        airborne_rendered_player.local_transform.rotation.z !== 0,
      );
      assertEquals(playthrough.completed.observation.status, {
        done: true,
        label: "Classic adventure starter",
        value: "Moved exit reached",
      });
      assertEquals(
        rendered_platformer_object(playthrough.completed, 10).position,
        [28_940_000, 3_875_000, 200_000],
      );
      const completed_animation = platformer_player_animation(
        playthrough.completed.snapshot,
      );
      assertEquals(completed_animation.sample_time, 1);
      assertAlmostEquals(completed_animation.position_offset[1], -0.14);
      assertAlmostEquals(completed_animation.rotation_z_radians, 0.14);
      assertAlmostEquals(completed_animation.scale[0], 1.18);
      assertAlmostEquals(completed_animation.scale[1], 0.84);
      const completed_scene = platformer_render_scene(
        playthrough.completed.snapshot,
        playthrough.completed.observation.sequence,
      );
      const completed_rendered_player = completed_scene.hierarchy.nodes.find(
        ({ id }) => id.index === 10,
      );
      assert(completed_rendered_player !== undefined);
      assertAlmostEquals(
        completed_rendered_player.local_transform.position.y,
        3.735,
      );
      assertAlmostEquals(
        2 * Math.atan2(
          completed_rendered_player.local_transform.rotation.z,
          completed_rendered_player.local_transform.rotation.w,
        ),
        0.14,
      );
      assertEquals(playthrough.replay_checksum, playthrough.snapshot_checksum);
      assertEquals(playthrough.replayed, playthrough.completed);
      const input_frames = playthrough.encoded_input_frames.map((source) =>
        decode_input_frame(new TextEncoder().encode(source))
      );
      assertEquals(input_frames.length, 4);
      assertEquals(
        input_frames[0].actions.find(({ id }) =>
          id === action_id("platformer.move_right")
        )?.value,
        { type: "digital", pressed: true, phase: "pressed" },
      );
      assertEquals(
        input_frames[2].actions.find(({ id }) =>
          id === action_id("platformer.jump")
        )?.value,
        { type: "digital", pressed: true, phase: "pressed" },
      );

      for (let index = 0; index < 20; index += 1) {
        runtime.observations.observer.event("platformer.test.evidence", {
          file_path: `/private/platformer-${index}.blot`,
          frame: index,
        });
      }
      assertEquals(runtime.observations.log.capacity, 16);
      assertEquals(runtime.observations.log.observations().length, 16);
      assert(runtime.observations.log.dropped() > 0);
      const retained = runtime.observations.log.observations().at(-1);
      assertEquals(
        retained?.type === "event" ? retained.evidence.file_path : undefined,
        "[redacted]",
      );
      const debugger_entries = runtime.observations.debugger_entries();
      assertEquals(debugger_entries.length, 16);
      assertStringIncludes(
        debugger_entries.at(-1)?.message ?? "",
        "[redacted]",
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
      {
        id: "headless:moved-exit-jump-replay-and-collision-parity",
        status: "passed",
      },
      {
        id: "headless:recorded-input-drives-moved-exit",
        status: "passed",
      },
      {
        id: "headless:player-animation-follows-blot-jump-state",
        status: "passed",
      },
    ], report_path);
  }
});
