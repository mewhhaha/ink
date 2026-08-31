import { build_blot_game } from "@ink/blot/build.ts";
import {
  parse_roleplaying_project,
  serialize_roleplaying_project,
} from "@ink/roleplaying-editor/serialization.ts";
import { assertEquals } from "@std/assert";
import { advance_roleplaying_timeline_action } from "../contract.ts";
import { move_roleplaying_actor } from "../edit.ts";
import { compile_roleplaying_project } from "../project.ts";
import {
  create_roleplaying_runtime,
  type RoleplayingRuntime,
} from "../runtime.ts";
import { rendered_roleplaying_object } from "./scenario.ts";

const application_directory = new URL("../../", import.meta.url);
const viewport = Object.freeze({ width: 960, height: 540 });

Deno.test("authored actor regions change the scene without bypassing timeline order", async () => {
  const starter = parse_roleplaying_project(
    await Deno.readTextFile(
      new URL("projects/starter.json", application_directory),
    ),
  );

  await with_roleplaying_project(
    serialize_roleplaying_project(
      move_roleplaying_actor(starter, "hero", "ruins"),
    ),
    "moved_player",
    async (runtime) => {
      const initial = await runtime.session.observe(viewport);
      assertEquals(
        initial.observation.status.value,
        "Village Keeper waits by the ruins road",
      );
      assertEquals(
        initial.observation.actions.some(({ id }) =>
          id === "activate:roleplaying.attack"
        ),
        false,
      );
      assertEquals(
        rendered_roleplaying_object(initial, 10).position,
        [-1_400_000, 900_000, 600_000],
      );
    },
  );

  await with_roleplaying_project(
    serialize_roleplaying_project(
      move_roleplaying_actor(starter, "sentinel", "village"),
    ),
    "moved_sentinel",
    async (runtime) => {
      const initial = await runtime.session.observe(viewport);
      assertEquals(
        rendered_roleplaying_object(initial, 12).visible,
        true,
      );
      await advance_roleplaying_timeline_action(
        runtime.session,
        { type: "activate", target: 30 },
      );
      const struck = await runtime.session.observe(viewport);
      assertEquals(
        struck.observation.status.value,
        "Village Keeper waits by the ruins road",
      );
      assertEquals(struck.effects, []);
    },
  );
});

async function with_roleplaying_project(
  source: string,
  artifact_name: string,
  exercise: (runtime: RoleplayingRuntime) => Promise<void>,
): Promise<void> {
  const compiled = compile_roleplaying_project(source);
  const temporary_directory = new URL(
    `${await Deno.makeTempDir({
      dir: application_directory.pathname,
      prefix: `.roleplaying-${artifact_name}-`,
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
      artifact_name,
      compiler: new URL("../../../blot/src/cli.ts", application_directory),
      entrypoint: new URL("src/blot/game/main.blot", temporary_directory),
      public_directory: new URL("generated/", temporary_directory),
      working_directory: application_directory,
    });
    const runtime = await create_roleplaying_runtime({
      wasm_bytes: await Deno.readFile(
        new URL(`generated/${artifact_name}.wasm`, temporary_directory),
      ),
      manifest_source: await Deno.readTextFile(
        new URL(`generated/${artifact_name}.wasm.json`, temporary_directory),
      ),
    });
    try {
      await exercise(runtime);
    } finally {
      await runtime.session.close();
    }
  } finally {
    await Deno.remove(temporary_directory, { recursive: true });
  }
}
