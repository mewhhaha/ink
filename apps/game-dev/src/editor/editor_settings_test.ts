import { assertEquals } from "@std/assert";
import {
  default_platformer_editor_settings,
  parse_platformer_editor_settings,
  write_platformer_editor_settings,
} from "./editor_settings.ts";

Deno.test("platformer editor settings round trip through search parameters", () => {
  const settings = {
    tool: "collision_shape",
    layer: "decoration",
    selected_tile: 42,
    selected_geometry: "collision-2",
    palette_position: { x: 312, y: 96 },
    palette_size: { width: 420, height: 360 },
    level_offset: { x: -48, y: 72 },
  } as const;
  const parameters = write_platformer_editor_settings(
    new URLSearchParams("unrelated=kept"),
    settings,
  );

  assertEquals(parse_platformer_editor_settings(parameters), settings);
  assertEquals(parameters.get("unrelated"), "kept");
});

Deno.test("malformed platformer editor settings use readable defaults", () => {
  assertEquals(
    parse_platformer_editor_settings(
      new URLSearchParams(
        "tool=nope&layer=both&tile=1.5&palette_width=20&level_x=Infinity",
      ),
    ),
    default_platformer_editor_settings,
  );
});
