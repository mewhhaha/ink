import { assertEquals, assertThrows } from "@std/assert";
import { blot } from "./adapter.ts";

Deno.test("Blot adapter describes its browser loader and artifact", () => {
  const adapter = blot({ game_id: "platformer" });

  assertEquals(adapter.artifact_name, "platformer");
  assertEquals(adapter.browser_factory, "create_blot_artifact_loader");
  assertEquals(adapter.configuration, { game_id: "platformer" });
  assertEquals(
    adapter.browser_module,
    new URL("./adapter.ts", import.meta.url),
  );
});

Deno.test("Blot adapter rejects an empty game identity", () => {
  assertThrows(
    () => blot({ game_id: "" }),
    Error,
    'Blot adapter game_id "" must be a non-empty string',
  );
});

Deno.test("Blot adapter preserves declared integer data assets", () => {
  const adapter = blot({
    game_id: "platformer",
    data_assets: [{ id: 0, url: "/assets/levels/starter.json" }],
  });

  assertEquals(adapter.configuration, {
    game_id: "platformer",
    data_assets: [{ id: 0, url: "/assets/levels/starter.json" }],
  });
});
