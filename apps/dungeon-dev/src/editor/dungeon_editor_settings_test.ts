import { assertEquals } from "@std/assert";
import {
  default_dungeon_editor_settings,
  parse_dungeon_editor_settings,
  write_dungeon_editor_settings,
} from "./dungeon_editor_settings.ts";

Deno.test("dungeon editor settings round trip through search parameters", () => {
  const settings = {
    tool: "wall",
    selected_slot: 12,
    viewport_offset: { x: -48, y: 72 },
    zoom: 1.25,
  } as const;
  const parameters = write_dungeon_editor_settings(
    new URLSearchParams("unrelated=kept"),
    settings,
  );
  assertEquals(parse_dungeon_editor_settings(parameters), settings);
  assertEquals(parameters.get("unrelated"), "kept");
});

Deno.test("malformed dungeon editor settings use readable defaults", () => {
  assertEquals(
    parse_dungeon_editor_settings(
      new URLSearchParams("tool=nope&brush=48&view_x=Infinity&zoom=3"),
    ),
    default_dungeon_editor_settings,
  );
});
