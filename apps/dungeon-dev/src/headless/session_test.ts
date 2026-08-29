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
import { microseconds } from "@ink/runtime/session.ts";
import { assertEquals } from "@std/assert";
import { game_adapter } from "../../ink.ts";
import {
  default_dungeon_debug_camera,
  dungeon_debug_camera_updates,
} from "../editor/dungeon_debug_camera.ts";
import {
  brush_preview_updates,
  player_start_preview_updates,
  remove_brush_preview_update,
} from "../editor/level.ts";

const viewport = { width: 960, height: 540 };

async function create_dungeon_session(): Promise<BlotRuntimeSession> {
  const [wasm_bytes, manifest_source, level_source] = await Promise.all([
    Deno.readFile(
      new URL("../../generated/dungeon_development.wasm", import.meta.url),
    ),
    Deno.readTextFile(
      new URL(
        "../../generated/dungeon_development.wasm.json",
        import.meta.url,
      ),
    ),
    Deno.readTextFile(
      new URL("../../generated/assets/levels/starter.json", import.meta.url),
    ),
  ]);
  return await game_adapter.create_session(wasm_bytes, manifest_source, {
    data_assets: [parse_blot_integer_data_asset(0, level_source)],
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
    assertEquals(presentation.observation.projection, "perspective");
    assertEquals(presentation.observation.camera_zoom, 0.9);

    assertEquals(presentation.snapshot.directional_light, {
      type: "directional_light",
      color: [1, 0.82, 0.62],
      direction: [-0.42, -0.86, -0.28],
      intensity: 1.35,
    });
    assertEquals(presentation.snapshot.resources, [
      { type: "mesh", id: 0, asset: asset_id<"mesh">("cube.obj") },
      {
        type: "mesh",
        id: 1,
        asset: asset_id<"mesh">("kenney/gate-door.obj"),
      },
      {
        type: "mesh",
        id: 2,
        asset: asset_id<"mesh">("kenney/stairs.obj"),
      },
      {
        type: "texture",
        id: 0,
        asset: asset_id<"texture">("materials/flagstone-floor.png"),
      },
      {
        type: "texture",
        id: 1,
        asset: asset_id<"texture">("materials/limestone-wall.png"),
      },
      {
        type: "texture",
        id: 2,
        asset: asset_id<"texture">("materials/oak-door.png"),
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
  const session = await create_dungeon_session();
  try {
    const initial = await session.observe(viewport);
    assertEquals(rendered_object(initial, 11).visible, true);
    assertEquals(rendered_object(initial, 106).visible, true);

    const take_key = required_action(
      new Map(
        initial.observation.actions.map(({ id, action }) => [id, action]),
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
    assertEquals(rendered_object(carrying_key, 11).visible, false);

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
    assertEquals((await session.observe(viewport)).observation.status, {
      done: true,
      label: "Third-person Action Adventure Starter",
      value: "Exit room reached",
    });

    const replay = await session.finish_replay();
    await session.reset();
    const replayed = await session.replay(replay);
    assertEquals(replayed.snapshot_checksum, completed.snapshot_checksum);
    assertEquals(
      (await session.observe(viewport)).observation.status.done,
      true,
    );
  } finally {
    await session.close();
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

Deno.test("orbit actions rotate the shared dungeon root", async () => {
  const session = await create_dungeon_session();
  try {
    const initial = await session.observe(viewport);
    const action = initial.observation.actions.find(({ id }) =>
      id === "orbit-right"
    )?.action;
    if (!action) throw new Error("orbit-right action is missing");
    assertEquals(initial.snapshot.nodes[0].rotation_radians[1], -0.32);
    await session.advance({
      elapsed_us: microseconds(0),
      inputs: [action],
    });
    assertEquals(
      (await session.observe(viewport)).snapshot.nodes[0].rotation_radians[1],
      -0.14,
    );
  } finally {
    await session.close();
  }
});

Deno.test("editor debug camera updates the local perspective transform", async () => {
  const session = await create_dungeon_session();
  try {
    const camera = {
      ...default_dungeon_debug_camera,
      yaw: 480_000,
      pitch: -900_000,
      offset_x: 1_200_000,
      offset_y: -300_000,
      offset_z: 2_000_000,
      zoom: 1_350_000,
    };
    await session.advance({
      elapsed_us: microseconds(0),
      inputs: dungeon_debug_camera_updates(
        default_dungeon_debug_camera,
        camera,
      ),
    });

    const snapshot = (await session.observe(viewport)).snapshot;
    assertEquals(snapshot.camera_zoom, 1.35);
    assertEquals(snapshot.nodes[0].rotation_radians, [-0.9, 0.48, 0]);
    assertEquals(snapshot.nodes[0].position, [
      1_200_000,
      -300_000,
      2_000_000,
    ]);
  } finally {
    await session.close();
  }
});
