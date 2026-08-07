import { assertEquals } from "@std/assert";
import { parse_blot_integer_data_asset } from "@ink/blot/data_asset.ts";
import type { HeadlessSession } from "@ink/blot/headless_session.ts";
import type { SceneObjectCommand } from "@ink/blot/protocol.ts";
import { game_adapter } from "../../ink.ts";

async function create_platformer_session(
  level_source?: string,
): Promise<HeadlessSession> {
  const [wasm_bytes, manifest_source, saved_level_source] = await Promise.all([
    Deno.readFile(
      new URL("../../generated/game_development.wasm", import.meta.url),
    ),
    Deno.readTextFile(
      new URL("../../generated/game_development.wasm.json", import.meta.url),
    ),
    Deno.readTextFile(
      new URL("../../assets/levels/starter.json", import.meta.url),
    ),
  ]);
  return await game_adapter.create_session(wasm_bytes, manifest_source, {
    data_assets: [
      parse_blot_integer_data_asset(0, level_source ?? saved_level_source),
    ],
  });
}

function rendered_object(
  session: HeadlessSession,
  object_id: number,
): SceneObjectCommand {
  const object = session.render().objects.find((candidate) =>
    candidate.id === object_id
  );
  if (!object) {
    throw new Error(`render snapshot is missing object ${object_id}`);
  }
  return object;
}

Deno.test("the saved level asset initializes both tile layers", async () => {
  const session = await create_platformer_session();
  try {
    const observation = session.describe();
    assertEquals(observation.status, {
      done: false,
      label: "Starter Meadow",
      value: "24 × 14",
    });
    assertEquals(observation.projection, "orthographic");
    assertEquals(observation.camera_zoom, 0.65);

    const terrain = rendered_object(session, 1000 + 181);
    assertEquals(terrain.visible, true);
    assertEquals(terrain.surface_mode, 4);
    assertEquals(terrain.texture_scale, [1 / 16, 1 / 16]);

    const empty_decoration = rendered_object(session, 2000);
    assertEquals(empty_decoration.visible, false);

    const player = rendered_object(session, 20);
    assertEquals(player.position, [-7_500_000, -4_500_000, 200_000]);
    assertEquals(player.surface_mode, 4);
    assertEquals(player.texture_scale, [1 / 8, 1 / 8]);
  } finally {
    session.close();
  }
});

Deno.test("moving the player start respawns the character at that cell", async () => {
  const session = await create_platformer_session();
  try {
    await session.step(
      { type: "custom", kind: 40, target: 672, value: 269 },
      0,
    );

    assertEquals(
      rendered_object(session, 20).position,
      [-6_500_000, -4_500_000, 200_000],
    );
  } finally {
    session.close();
  }
});

Deno.test("player actions move, jump, land, and restart the character", async () => {
  const session = await create_platformer_session();
  try {
    const observation = session.describe();
    assertEquals(observation.actions, [
      {
        id: "move-left-start",
        label: "Move left",
        action: { type: "custom", kind: 10, target: 0, value: 0 },
      },
      {
        id: "move-left-stop",
        label: "Stop moving left",
        action: { type: "custom", kind: 11, target: 0, value: 0 },
      },
      {
        id: "move-right-start",
        label: "Move right",
        action: { type: "custom", kind: 12, target: 0, value: 0 },
      },
      {
        id: "move-right-stop",
        label: "Stop moving right",
        action: { type: "custom", kind: 13, target: 0, value: 0 },
      },
      {
        id: "jump",
        label: "Jump",
        action: { type: "custom", kind: 14, target: 0, value: 0 },
      },
      {
        id: "restart",
        label: "Restart",
        action: { type: "custom", kind: 15, target: 0, value: 0 },
      },
    ]);

    await session.step(observation.actions[2].action, 0);
    for (let frame = 0; frame < 10; frame += 1) {
      await session.step({ type: "frame" }, 50_000);
    }
    assertEquals(
      rendered_object(session, 20).position,
      [-5_250_000, -4_500_000, 200_000],
    );

    await session.step(observation.actions[3].action, 0);
    await session.step(observation.actions[4].action, 0);
    await session.step({ type: "frame" }, 50_000);
    assertEquals(
      rendered_object(session, 20).position,
      [-5_250_000, -4_130_000, 200_000],
    );

    for (let frame = 0; frame < 20; frame += 1) {
      await session.step({ type: "frame" }, 50_000);
    }
    assertEquals(
      rendered_object(session, 20).position,
      [-5_250_000, -4_500_000, 200_000],
    );

    await session.step(observation.actions[5].action, 0);
    assertEquals(
      rendered_object(session, 20).position,
      [-7_500_000, -4_500_000, 200_000],
    );
  } finally {
    session.close();
  }
});

Deno.test("an editor preview event replaces exactly one tile", async () => {
  const session = await create_platformer_session();
  try {
    assertEquals(rendered_object(session, 1000).visible, false);

    await session.step({ type: "custom", kind: 40, target: 0, value: 18 }, 0);

    const painted = rendered_object(session, 1000);
    assertEquals(painted.visible, true);
    assertEquals(painted.texture_offset, [2 / 16, 1 / 16]);
    assertEquals(rendered_object(session, 1001).visible, false);
  } finally {
    session.close();
  }
});

Deno.test("a long fall cannot tunnel through a one-tile floor", async () => {
  const columns = 3;
  const rows = 100;
  const floor_row = 90;
  const terrain = Array(columns * rows).fill(-1);
  terrain.fill(0, floor_row * columns, (floor_row + 1) * columns);
  const session = await create_platformer_session(JSON.stringify({
    format: "blot-integer-data",
    version: 1,
    fields: [
      [columns],
      [rows],
      terrain,
      Array(columns * rows).fill(-1),
      [1],
    ],
  }));
  const resting_y = -39_500_000;
  let landed = false;
  try {
    for (let frame = 0; frame < 200; frame += 1) {
      await session.step({ type: "frame" }, 50_000);
      const y = rendered_object(session, 20).position[1];
      if (y < resting_y) {
        throw new Error(
          `player crossed floor ${floor_row} on frame ${frame} at y ${y}`,
        );
      }
      if (y === resting_y) landed = true;
    }
    assertEquals(landed, true);
  } finally {
    session.close();
  }
});

Deno.test("either foot supports the player at a platform edge", async () => {
  const columns = 5;
  const rows = 4;
  const terrain = Array(columns * rows).fill(-1);
  terrain[2 * columns + 2] = 0;
  const session = await create_platformer_session(JSON.stringify({
    format: "blot-integer-data",
    version: 1,
    fields: [
      [columns],
      [rows],
      terrain,
      Array(columns * rows).fill(-1),
      [columns + 2],
    ],
  }));
  try {
    await session.step({ type: "custom", kind: 12, target: 0, value: 0 }, 0);
    for (let frame = 0; frame < 3; frame += 1) {
      await session.step({ type: "frame" }, 50_000);
    }
    assertEquals(rendered_object(session, 20).position, [
      675_000,
      500_000,
      200_000,
    ]);

    await session.step({ type: "frame" }, 50_000);
    assertEquals(rendered_object(session, 20).position, [
      900_000,
      445_000,
      200_000,
    ]);
  } finally {
    session.close();
  }
});
