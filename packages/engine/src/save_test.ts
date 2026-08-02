import { assertEquals, assertRejects } from "@std/assert";
import { create_game_save, parse_game_save } from "./save.ts";

Deno.test("save identity comes from the loaded game context", async () => {
  const context = {
    game_id: "example_game",
    artifact_digest: "artifact",
    schema_digest: "schema",
  };
  const save = await create_game_save(12n, 34n, context);

  assertEquals(save.game, "example_game");
  await assertRejects(
    () =>
      parse_game_save(JSON.stringify(save), {
        ...context,
        game_id: "another_game",
      }),
    Error,
    "another_game",
  );
});
