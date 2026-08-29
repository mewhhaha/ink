import { build_blot_game } from "@ink/blot/build.ts";
import { asset_id } from "@ink/assets/identity.ts";
import type {
  BlotPresentation,
  BlotRuntimeSession,
} from "@ink/blot/runtime.ts";
import type { GameAction, SceneObjectCommand } from "@ink/blot/protocol.ts";
import { move_platformer_record } from "@ink/platformer-editor/commands.ts";
import {
  platformer_level_id,
  platformer_record_id,
} from "@ink/platformer-editor/identity.ts";
import {
  parse_platformer_project,
  serialize_platformer_project,
} from "@ink/platformer-editor/serialization.ts";
import { microseconds } from "@ink/runtime/session.ts";
import { assertEquals } from "@std/assert";
import { compile_platformer_project } from "../project.ts";
import { create_platformer_session } from "../runtime.ts";

const viewport = { width: 960, height: 540 };
const application_directory = new URL("../../", import.meta.url);

async function create_session(
  artifact_name = "platformer_development",
  directory = new URL("../../generated/", import.meta.url),
): Promise<BlotRuntimeSession> {
  const [wasm_bytes, manifest_source] = await Promise.all([
    Deno.readFile(new URL(`${artifact_name}.wasm`, directory)),
    Deno.readTextFile(new URL(`${artifact_name}.wasm.json`, directory)),
  ]);
  return await create_platformer_session(wasm_bytes, manifest_source);
}

function required_action(
  presentation: BlotPresentation,
  id: string,
): GameAction {
  const description = presentation.observation.actions.find((action) =>
    action.id === id
  );
  if (description === undefined) {
    throw new Error(`platformer action ${JSON.stringify(id)} is missing`);
  }
  return description.action;
}

function rendered_object(
  presentation: BlotPresentation,
  object_id: number,
): SceneObjectCommand {
  const object = presentation.snapshot.objects.find(({ id }) =>
    id === object_id
  );
  if (object === undefined) {
    throw new Error(`platformer snapshot is missing object ${object_id}`);
  }
  return object;
}

async function advance_frames(
  session: BlotRuntimeSession,
  count: number,
): Promise<void> {
  for (let frame = 0; frame < count; frame += 1) {
    await session.advance({ elapsed_us: microseconds(50_000), inputs: [] });
  }
}

Deno.test("the platformer guest renders the editor-authored spawn, exit, and collision", async () => {
  const session = await create_session();
  try {
    const presentation = await session.observe(viewport);
    assertEquals(presentation.observation.status, {
      done: false,
      label: "First steps",
      value: "Run and jump to the exit",
    });
    assertEquals(presentation.observation.projection, "orthographic");
    assertEquals(presentation.snapshot.resources, [{
      type: "mesh",
      id: 0,
      asset: asset_id<"mesh">("cube.obj"),
    }]);
    assertEquals(rendered_object(presentation, 100).position, [
      3_000_000,
      2_000_000,
      0,
    ]);
    assertEquals(rendered_object(presentation, 101).position, [
      29_500_000,
      4_000_000,
      100_000,
    ]);
    assertEquals(rendered_object(presentation, 101).emissive, 0.24);
    assertEquals(rendered_object(presentation, 102).scale, [
      32_000_000,
      2_000_000,
      200_000,
    ]);
  } finally {
    await session.close();
  }
});

Deno.test("running and jumping to the authored exit replays with the same checksum", async () => {
  const session = await create_session();
  try {
    const initial = await session.observe(viewport);
    await session.advance({
      elapsed_us: microseconds(0),
      inputs: [
        required_action(initial, "right-start"),
        required_action(initial, "jump"),
      ],
    });
    assertEquals(
      rendered_object(await session.observe(viewport), 100).position[0],
      3_000_000,
    );

    await advance_frames(session, 72);
    const completed = await session.observe(viewport);
    assertEquals(completed.observation.status, {
      done: true,
      label: "Classic adventure starter",
      value: "Exit reached after a jump",
    });
    const completed_revision = await session.advance({
      elapsed_us: microseconds(0),
      inputs: [required_action(completed, "right-stop")],
    });

    const replay = await session.finish_replay();
    await session.reset();
    const replayed = await session.replay(replay);
    assertEquals(
      replayed.snapshot_checksum,
      completed_revision.snapshot_checksum,
    );
    assertEquals(
      (await session.observe(viewport)).observation.status.done,
      true,
    );
  } finally {
    await session.close();
  }
});

Deno.test("moving the exit and rebuilding makes the new location authoritative", async () => {
  const starter_source = await Deno.readTextFile(
    new URL("../../projects/starter.json", import.meta.url),
  );
  const moved_project = move_platformer_record(
    parse_platformer_project(starter_source),
    platformer_level_id("first-steps"),
    platformer_record_id("level-exit"),
    { x: -20, y: 0 },
  );
  const compiled = compile_platformer_project(
    serialize_platformer_project(moved_project),
  );
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
      artifact_name: "moved_platformer",
      assets_directory: new URL("assets/", application_directory),
      compiler: new URL("../../../blot/src/cli.ts", application_directory),
      entrypoint: new URL("src/blot/game/main.blot", temporary_directory),
      public_directory: new URL("generated/", temporary_directory),
      working_directory: application_directory,
    });

    const session = await create_session(
      "moved_platformer",
      new URL("generated/", temporary_directory),
    );
    try {
      const initial = await session.observe(viewport);
      assertEquals(rendered_object(initial, 101).position[0], 9_500_000);
      await session.advance({
        elapsed_us: microseconds(0),
        inputs: [
          required_action(initial, "right-start"),
          required_action(initial, "jump"),
        ],
      });
      await advance_frames(session, 15);
      assertEquals(
        (await session.observe(viewport)).observation.status.done,
        true,
      );
    } finally {
      await session.close();
    }
  } finally {
    await Deno.remove(temporary_directory, { recursive: true });
  }
});
