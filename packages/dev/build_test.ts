import { assertEquals, assertRejects } from "@std/assert";
import { buildPlayer } from "./build.ts";
import { resolveProject } from "./node.ts";

Deno.test("failed builds preserve outputs and cannot overwrite source assets or unmarked directories", async () => {
  const root = await Deno.makeTempDir({ prefix: "ink-build-test-" });
  try {
    await Deno.mkdir(`${root}/assets`);
    await Deno.mkdir(`${root}/scenes`);
    await Deno.mkdir(`${root}/game`);
    await Deno.mkdir(`${root}/dist`);
    await Deno.writeTextFile(
      `${root}/schema.ts`,
      'import { defineSchema } from "@ink/schema"; export default defineSchema({});',
    );
    await Deno.writeTextFile(
      `${root}/scenes/main.scene.json`,
      '{"ink":1,"entities":[]}',
    );
    await Deno.writeTextFile(`${root}/game/main.blot`, "this is not a game");
    await Deno.writeTextFile(`${root}/dist/valuable.txt`, "keep this");
    const project = await resolveProject(root, {});
    await assertRejects(
      () => buildPlayer(project),
      Error,
      "without an Ink build manifest",
    );
    await assertRejects(
      () => buildPlayer(project, { out: `${root}/assets/output` }),
      Error,
      "source assets",
    );
    await assertRejects(
      () => buildPlayer(project, { out: root }),
      Error,
      "replace the project",
    );
    await Deno.writeTextFile(`${root}/dist/ink-build.json`, '{"inkBuild":1}');
    await assertRejects(() => buildPlayer(project));
    assertEquals(
      await Deno.readTextFile(`${root}/dist/valuable.txt`),
      "keep this",
    );
    assertEquals(
      await Deno.readTextFile(`${root}/dist/ink-build.json`),
      '{"inkBuild":1}',
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
