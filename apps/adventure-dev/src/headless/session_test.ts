import { parse_blot_integer_data_asset } from "@ink/blot/data_asset.ts";
import { asset_id } from "@ink/assets/identity.ts";
import type {
  BlotPresentation,
  BlotRuntimeSession,
} from "@ink/blot/runtime.ts";
import type { GameAction, SceneObjectCommand } from "@ink/blot/protocol.ts";
import {
  type AdventureBrush,
  maximum_adventure_brushes,
} from "@ink/adventure-editor/layout.ts";
import { Observer } from "@ink/observability/observer.ts";
import { create_redacting_sink } from "@ink/observability/redaction.ts";
import { create_ring_buffer_sink } from "@ink/observability/sink.ts";
import { microseconds } from "@ink/runtime/session.ts";
import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertNotEquals,
} from "@std/assert";
import {
  scenario_report_environment,
  write_scenario_assertion_report,
} from "../../../../scripts/scenario_report.ts";
import { game_adapter } from "../game_adapter.ts";
import { adventure_gate_animation } from "../browser/gate_animation.ts";
import { AdventureAudio } from "../browser/audio.ts";
import {
  brush_preview_updates,
  player_start_preview_updates,
  remove_brush_preview_update,
} from "../editor/level.ts";
import { load_adventure_level_source } from "../level_asset.ts";
import { compile_adventure_project } from "../project.ts";

const viewport = { width: 960, height: 540 };

async function create_dungeon_session(): Promise<BlotRuntimeSession> {
  const [wasm_bytes, manifest_source, level_source] = await Promise.all([
    Deno.readFile(
      new URL("../../generated/adventure_development.wasm", import.meta.url),
    ),
    Deno.readTextFile(
      new URL(
        "../../generated/adventure_development.wasm.json",
        import.meta.url,
      ),
    ),
    load_adventure_level_source(
      new URL("../../generated/", import.meta.url),
    ),
  ]);
  return await game_adapter.create_session(wasm_bytes, manifest_source, {
    data_assets: [parse_blot_integer_data_asset(0, level_source)],
    observer: new Observer({
      source: { subsystem: "adventure-headless-test" },
      sink: create_redacting_sink(create_ring_buffer_sink(100)),
      clock: { now_seconds: () => performance.now() / 1_000 },
    }),
  });
}

function rendered_object(
  presentation: BlotPresentation,
  object_id: number,
): SceneObjectCommand {
  const object = presentation.snapshot.objects.find(({ id }) =>
    id === object_id
  );
  if (!object) {
    throw new Error(`render snapshot is missing object ${object_id}`);
  }
  return object;
}

function required_action(
  actions: ReadonlyMap<string, GameAction>,
  id: string,
): GameAction {
  const action = actions.get(id);
  if (action === undefined) throw new Error(`game action ${id} is missing`);
  return action;
}

Deno.test("the starter dungeon renders textured 3D brushes and sourced models", async () => {
  const session = await create_dungeon_session();
  try {
    const presentation = await session.observe(viewport);
    assertEquals(presentation.observation.status, {
      done: false,
      label: "Dungeon Workshop",
      value: "Take brass key",
    });
    assertEquals(presentation.snapshot.camera, {
      type: "perspective",
      position: [0, -0.195878, 6.986532],
      target: [-0.8, -0.103599, 4.103568],
      clear_color: [0.012, 0.018, 0.032],
      vertical_fov_radians: 1.240499,
    });
    assertEquals(presentation.snapshot.environment, {
      ambient_light: [0.28, 0.24, 0.2],
      fog_color: [0.012, 0.018, 0.032],
      fog_density: 0.003,
      exposure_ev100: 0.75,
      bloom_intensity: 0.08,
    });

    assertEquals(presentation.snapshot.directional_light, {
      type: "directional_light",
      color: [1, 0.82, 0.62],
      direction: [-0.42, -0.86, -0.28],
      intensity: 1.35,
    });
    assertEquals(presentation.snapshot.resources, [
      {
        type: "mesh",
        id: 0,
        asset: asset_id<"mesh">("adventure/mesh/cube"),
      },
      {
        type: "mesh",
        id: 1,
        asset: asset_id<"mesh">("adventure/mesh/oak-gate"),
      },
      {
        type: "mesh",
        id: 2,
        asset: asset_id<"mesh">("adventure/mesh/stone-stairs"),
      },
      {
        type: "texture",
        id: 0,
        asset: asset_id<"texture">("adventure/texture/flagstone-floor"),
      },
      {
        type: "texture",
        id: 1,
        asset: asset_id<"texture">("adventure/texture/limestone-wall"),
      },
      {
        type: "texture",
        id: 2,
        asset: asset_id<"texture">("adventure/texture/oak-door"),
      },
    ]);

    const foundation = rendered_object(presentation, 100);
    assertEquals(foundation.parent, 1);
    assertEquals(foundation.position, [0, -500_000, 0]);
    assertEquals(foundation.scale, [14_000_000, 1_000_000, 10_000_000]);
    assertEquals(foundation.texture, 0);

    const gate = rendered_object(presentation, 106);
    assertEquals(gate.mesh, 1);
    assertEquals(gate.texture, 2);
    assertEquals(gate.position, [0, 0, 4_500_000]);
    assertEquals(gate.surface_mode, 2);
    assertEquals(gate.texture_scale, [0.227273, 0.227273]);
    assertEquals(gate.texture_offset, [0.386364, 0.886364]);

    const stairs = rendered_object(presentation, 108);
    assertEquals(stairs.mesh, 2);
    assertEquals(stairs.texture, 1);
    assertEquals(rendered_object(presentation, 10).position, [
      0,
      500_000,
      2_000_000,
    ]);
    assertEquals(rendered_object(presentation, 11).position, [
      3_000_000,
      1_150_000,
      2_000_000,
    ]);
  } finally {
    await session.close();
  }
});

Deno.test("the authored key unlocks the oak gate and replay reaches the same exit state", async () => {
  const project_source = await Deno.readTextFile(
    new URL("../../projects/starter.json", import.meta.url),
  );
  const compiled = compile_adventure_project(project_source);
  assertEquals(compiled.traversal.closed_gate, {
    type: "blocked",
    navigation_result: "unavailable",
    stop_x_microunits: 0,
    stop_z_microunits: 3_490_000,
    physics_contacts: 1,
  });
  assertEquals(compiled.traversal.open_gate, {
    type: "route",
    goal_x_microunits: 0,
    goal_z_microunits: 4_750_000,
    navigation_revision: 1,
    path_points: 7,
    path_cost_microunits: 3_000_000,
  });
  const session = await create_dungeon_session();
  const audio = new AdventureAudio();
  try {
    const initial = await session.observe(viewport);
    assertEquals(
      initial.observation.actions.some(({ id }) => id === "enter-exit-room"),
      false,
    );
    assertEquals(rendered_object(initial, 11).visible, true);
    assertEquals(rendered_object(initial, 106).visible, true);
    const closed_gate = adventure_gate_animation(initial.snapshot);
    assertEquals(closed_gate.sample_time, 0);
    assertAlmostEquals(closed_gate.rotation_y_radians, 0);

    const move_toward_gate = required_action(
      new Map(
        initial.observation.actions.map(({ id, action }) => [id, action]),
      ),
      "backward-start",
    );
    await session.advance({
      elapsed_us: microseconds(0),
      inputs: [move_toward_gate],
    });
    for (let frame = 0; frame < 20; frame += 1) {
      await session.advance({
        elapsed_us: microseconds(50_000),
        inputs: [],
      });
    }
    const stopped_by_gate = await session.observe(viewport);
    assertEquals(rendered_object(stopped_by_gate, 10).position, [
      compiled.traversal.closed_gate.stop_x_microunits,
      500_000,
      compiled.traversal.closed_gate.stop_z_microunits,
    ]);
    await session.advance({
      elapsed_us: microseconds(0),
      inputs: [required_action(
        new Map(
          stopped_by_gate.observation.actions.map(({ id, action }) => [
            id,
            action,
          ]),
        ),
        "backward-stop",
      )],
    });

    const take_key = required_action(
      new Map(
        stopped_by_gate.observation.actions.map(({ id, action }) => [
          id,
          action,
        ]),
      ),
      "take-brass-key",
    );
    await session.advance({ elapsed_us: microseconds(0), inputs: [take_key] });
    const carrying_key = await session.observe(viewport);
    assertEquals(carrying_key.observation.status, {
      done: false,
      label: "Brass key acquired",
      value: "Unlock oak gate",
    });
    assertEquals(carrying_key.effects, [{
      type: "play_audio",
      id: "adventure.key-acquired",
      cue: asset_id<"audio">("adventure.key"),
    }]);
    const key_spatial = audio.play(
      asset_id<"audio">("adventure.key"),
      carrying_key.snapshot,
    );
    assert(key_spatial.gain > 0 && key_spatial.gain < 1);
    assert(Math.abs(key_spatial.pan) > 0.5);
    assertEquals(key_spatial.doppler_pitch, 1);
    assertEquals(rendered_object(carrying_key, 11).visible, false);
    assertEquals(
      carrying_key.observation.actions.some(({ id }) =>
        id === "enter-exit-room"
      ),
      false,
    );

    const unlock_gate = required_action(
      new Map(
        carrying_key.observation.actions.map(({ id, action }) => [id, action]),
      ),
      "unlock-oak-gate",
    );
    await session.advance({
      elapsed_us: microseconds(0),
      inputs: [unlock_gate],
    });
    const open_gate = await session.observe(viewport);
    assertEquals(rendered_object(open_gate, 106).visible, false);
    const opened_gate = adventure_gate_animation(open_gate.snapshot);
    assertEquals(opened_gate.sample_time, 1);
    assertEquals(opened_gate.position_offset, [-1.6, 0, -1.4]);
    assertAlmostEquals(opened_gate.rotation_y_radians, -Math.PI * 0.44);
    assertEquals(opened_gate.rendered_visible, true);
    assertEquals(open_gate.effects, [{
      type: "play_audio",
      id: "adventure.gate-unlocked",
      cue: asset_id<"audio">("adventure.gate"),
    }]);
    const gate_spatial = audio.play(
      asset_id<"audio">("adventure.gate"),
      open_gate.snapshot,
    );
    assert(gate_spatial.gain > 0 && gate_spatial.gain < 1);
    assertNotEquals(gate_spatial.doppler_pitch, 1);

    const enter_exit = required_action(
      new Map(
        open_gate.observation.actions.map(({ id, action }) => [id, action]),
      ),
      "enter-exit-room",
    );
    const completed = await session.advance({
      elapsed_us: microseconds(0),
      inputs: [enter_exit],
    });
    const exit_room = await session.observe(viewport);
    assertEquals(exit_room.observation.status, {
      done: true,
      label: "Third-person Action Adventure Starter",
      value: "Exit room reached",
    });
    assertEquals(exit_room.effects, [{
      type: "play_audio",
      id: "adventure.exit-reached",
      cue: asset_id<"audio">("adventure.exit"),
    }]);
    assertEquals(rendered_object(exit_room, 10).position, [
      compiled.traversal.open_gate.goal_x_microunits,
      500_000,
      compiled.traversal.open_gate.goal_z_microunits,
    ]);
    const exit_spatial = audio.play(
      asset_id<"audio">("adventure.exit"),
      exit_room.snapshot,
    );
    assertEquals(exit_spatial.gain, 1);
    assertEquals(exit_spatial.pan, 0);
    assertEquals(exit_spatial.doppler_pitch, 1);

    const replay = await session.finish_replay();
    await session.reset();
    const replayed = await session.replay(replay);
    assertEquals(replayed.snapshot_checksum, completed.snapshot_checksum);
    assertEquals(
      (await session.observe(viewport)).observation.status.done,
      true,
    );
  } finally {
    await audio.close();
    await session.close();
  }
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--config",
      "../../deno.json",
      "--allow-read",
      "src/headless/main.ts",
    ],
    cwd: new URL("../../", import.meta.url),
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();
  const input = child.stdin.getWriter();
  await input.write(new TextEncoder().encode([
    JSON.stringify({
      id: "initial",
      command: "observe",
      query: viewport,
    }),
    JSON.stringify({ id: "close", command: "close" }),
    "",
  ].join("\n")));
  await input.close();
  const output = await child.output();
  const stderr = new TextDecoder().decode(output.stderr);
  assertEquals(output.code, 0, stderr);
  const responses = new TextDecoder().decode(output.stdout).trim().split("\n")
    .map((line) => JSON.parse(line));
  assertEquals(responses.length, 2);
  assertEquals(responses[0].id, "initial");
  assertEquals(responses[0].ok, true);
  assertEquals(responses[0].result.observation.status.value, "Take brass key");
  assertEquals(responses[1], {
    id: "close",
    ok: true,
    result: { closed: true },
  });
  const report_path = Deno.env.get(scenario_report_environment);
  if (report_path !== undefined) {
    await write_scenario_assertion_report([
      {
        id: "headless:gate-unlocks-and-replay-matches",
        status: "passed",
      },
      {
        id: "headless:oak-gate-animation-follows-blot-state",
        status: "passed",
      },
      {
        id: "headless:canonical-route-blocks-before-gate-opens",
        status: "passed",
      },
      {
        id: "headless:spatial-audio-follows-blot-presentation",
        status: "passed",
      },
      {
        id: "headless:jsonl-executable-observes-and-closes",
        status: "passed",
      },
    ], report_path);
  }
});

Deno.test("editor updates batch a 3D brush change without advancing time", async () => {
  const session = await create_dungeon_session();
  const initial = await session.observe(viewport);
  const occupied_objects = new Set(
    initial.snapshot.objects.map(({ id }) => id),
  );
  const vacant_slot = Array.from(
    { length: maximum_adventure_brushes },
    (_, slot) => slot,
  ).find((slot) => !occupied_objects.has(100 + slot));
  if (vacant_slot === undefined) {
    throw new Error(
      `starter dungeon has no vacant slot among ${maximum_adventure_brushes} brushes`,
    );
  }
  const preview_object_id = 100 + vacant_slot;
  const brush: AdventureBrush = {
    slot: vacant_slot,
    id: "preview-wall",
    kind: "block",
    center_x2: 5,
    elevation: 0,
    center_z2: -7,
    width: 4,
    height: 3,
    depth: 1,
    yaw_quarters: 0,
    material: "dungeon.wall.limestone",
  };
  try {
    assertEquals(
      initial.snapshot.objects.some(({ id }) => id === preview_object_id),
      false,
    );
    await session.advance({
      elapsed_us: microseconds(0),
      inputs: brush_preview_updates(brush),
    });
    const preview = rendered_object(
      await session.observe(viewport),
      preview_object_id,
    );
    assertEquals(preview.position, [2_500_000, 1_500_000, -3_500_000]);
    assertEquals(preview.scale, [4_000_000, 3_000_000, 1_000_000]);
    assertEquals(preview.texture, 1);

    await session.advance({
      elapsed_us: microseconds(0),
      inputs: [remove_brush_preview_update(vacant_slot)],
    });
    assertEquals(
      (await session.observe(viewport)).snapshot.objects.some(({ id }) =>
        id === preview_object_id
      ),
      false,
    );
  } finally {
    await session.close();
  }
});

Deno.test("WASD actions move the player and restart restores the saved spawn", async () => {
  const session = await create_dungeon_session();
  try {
    const actions = new Map(
      (await session.observe(viewport)).observation.actions.map((
        { id, action },
      ) => [
        id,
        action,
      ]),
    );
    await session.advance({
      elapsed_us: microseconds(0),
      inputs: [required_action(actions, "forward-start")],
    });
    for (let frame = 0; frame < 10; frame += 1) {
      await session.advance({ elapsed_us: microseconds(50_000), inputs: [] });
    }
    await session.advance({
      elapsed_us: microseconds(0),
      inputs: [required_action(actions, "forward-stop")],
    });
    assertEquals(
      rendered_object(await session.observe(viewport), 10).position,
      [0, 500_000, 600_000],
    );

    await session.advance({
      elapsed_us: microseconds(0),
      inputs: player_start_preview_updates({ x2: 6, z2: -4 }),
    });
    assertEquals(
      rendered_object(await session.observe(viewport), 10).position,
      [3_000_000, 500_000, -2_000_000],
    );

    await session.advance({
      elapsed_us: microseconds(0),
      inputs: [required_action(actions, "restart")],
    });
    assertEquals(
      rendered_object(await session.observe(viewport), 10).position,
      [0, 500_000, 2_000_000],
    );
  } finally {
    await session.close();
  }
});

Deno.test("gameplay orbit is the only camera transform serialized in the dungeon root", async () => {
  const session = await create_dungeon_session();
  try {
    const initial = await session.observe(viewport);
    const action = initial.observation.actions.find(({ id }) =>
      id === "orbit-right"
    )?.action;
    if (!action) throw new Error("orbit-right action is missing");
    assertEquals(initial.snapshot.nodes[0].rotation_radians, [0, -0.32, 0]);
    assertEquals(initial.snapshot.nodes[0].position, [0, 0, 0]);
    await session.advance({
      elapsed_us: microseconds(0),
      inputs: [action],
    });
    assertEquals(
      (await session.observe(viewport)).snapshot.nodes[0],
      {
        ...initial.snapshot.nodes[0],
        rotation_radians: [0, -0.14, 0],
      },
    );
  } finally {
    await session.close();
  }
});
