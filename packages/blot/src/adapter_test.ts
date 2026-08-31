import { assertEquals, assertThrows } from "@std/assert";
import { blot } from "./adapter.ts";

Deno.test("Blot adapter describes its artifact and runtime configuration", () => {
  const adapter = blot({ game_id: "platformer" });

  assertEquals(adapter.artifact_name, "platformer");
  assertEquals(adapter.configuration, { game_id: "platformer" });
});

Deno.test("Blot adapter rejects an empty game identity", () => {
  assertThrows(
    () => blot({ game_id: "" }),
    Error,
    'Blot adapter game_id "" must be a non-empty string',
  );
});

Deno.test("Blot adapter rejects raw asset locations", () => {
  assertThrows(
    () => blot({ game_id: "platformer", data_assets: [] } as never),
    Error,
    'Blot adapter configuration fields ["data_assets","game_id"] must be ["game_id"]',
  );
});
