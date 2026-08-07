import { assertEquals, assertThrows } from "@std/assert";
import {
  game_development_path,
  resolve_game_development_view,
} from "./browser_routes.ts";

Deno.test("game development routes resolve predictable editor and game paths", () => {
  assertEquals(resolve_game_development_view("/editor"), "editor");
  assertEquals(resolve_game_development_view("/editor/"), "editor");
  assertEquals(resolve_game_development_view("/game"), "game");
  assertEquals(resolve_game_development_view("/game/"), "game");
  assertEquals(resolve_game_development_view("/"), "editor");
  assertEquals(resolve_game_development_view("/", "game"), "game");
  assertEquals(game_development_path("editor"), "/editor");
  assertEquals(game_development_path("game"), "/game");
});

Deno.test("game development routes reject unknown paths", () => {
  assertThrows(
    () => resolve_game_development_view("/inspector"),
    Error,
    'pathname "/inspector" is unsupported',
  );
});
