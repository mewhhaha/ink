import type { AdventureBrush } from "@ink/adventure-editor/layout.ts";
import { assertEquals, assertThrows } from "@std/assert";
import {
  brush_preview_updates,
  player_start_preview_updates,
  remove_brush_preview_update,
} from "./level.ts";

const gate: AdventureBrush = {
  slot: 3,
  id: "oak-gate",
  kind: "door",
  center_x2: 5,
  elevation: 0,
  center_z2: -3,
  width: 2,
  height: 3,
  depth: 1,
  yaw_quarters: 1,
  material: "dungeon.gate.oak",
};

Deno.test("brush preview updates address each compiled field in one stable slot", () => {
  assertEquals(brush_preview_updates(gate), [
    { type: "custom", kind: 40, target: 3, value: 129 },
    { type: "custom", kind: 40, target: 51, value: 133 },
    { type: "custom", kind: 40, target: 99, value: 128 },
    { type: "custom", kind: 40, target: 147, value: 125 },
    { type: "custom", kind: 40, target: 195, value: 130 },
    { type: "custom", kind: 40, target: 243, value: 131 },
    { type: "custom", kind: 40, target: 291, value: 129 },
    { type: "custom", kind: 40, target: 339, value: 129 },
    { type: "custom", kind: 40, target: 387, value: 130 },
  ]);
});

Deno.test("preview removal and player start updates use reserved cells", () => {
  assertEquals(remove_brush_preview_update(3), {
    type: "custom",
    kind: 40,
    target: 3,
    value: 127,
  });
  assertEquals(player_start_preview_updates({ x2: 6, z2: -4 }), [
    { type: "custom", kind: 40, target: 432, value: 134 },
    { type: "custom", kind: 40, target: 433, value: 124 },
  ]);
});

Deno.test("preview removal rejects slots outside the compiled layout", () => {
  assertThrows(
    () => remove_brush_preview_update(48),
    Error,
    "adventure brush slot 48 must be an integer in 0..47",
  );
});
