import { assertEquals, assertThrows } from "@std/assert";
import {
  type AdventureLayout,
  apply_adventure_layout_command,
  parse_adventure_layout,
  serialize_adventure_layout,
  validate_adventure_layout,
} from "./layout.ts";

const layout: AdventureLayout = {
  format: "ink-adventure-layout",
  version: 1,
  name: "Test dungeon",
  player_start: { x2: 1, z2: 3 },
  brushes: [{
    slot: 0,
    id: "floor-1",
    kind: "block",
    center_x2: 0,
    elevation: -1,
    center_z2: 0,
    width: 6,
    height: 1,
    depth: 4,
    yaw_quarters: 0,
    material: "dungeon.floor.flagstone",
  }, {
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
  }],
  interaction_bindings: [{ interaction: "unlock-gate", brush: "oak-gate" }],
};

Deno.test("adventure layouts round trip canonically", () => {
  assertEquals(
    parse_adventure_layout(serialize_adventure_layout(layout)),
    layout,
  );
});

Deno.test("adventure commands allocate stable slots and retain bindings", () => {
  const added = apply_adventure_layout_command(layout, {
    type: "add_brush",
    brush: {
      id: "wall-1",
      kind: "block",
      center_x2: 2,
      elevation: 0,
      center_z2: 4,
      width: 1,
      height: 3,
      depth: 4,
      yaw_quarters: 0,
      material: "dungeon.wall.limestone",
    },
  });
  assertEquals(added.brushes.find(({ id }) => id === "wall-1")?.slot, 1);
  assertEquals(added.interaction_bindings, layout.interaction_bindings);
});

Deno.test("removing a brush also removes its interaction binding", () => {
  const removed = apply_adventure_layout_command(layout, {
    type: "remove_brush",
    slot: 3,
  });
  assertEquals(removed.interaction_bindings, []);
});

Deno.test("layout diagnostics identify duplicate and missing references", () => {
  assertEquals(
    validate_adventure_layout({
      ...layout,
      brushes: [layout.brushes[0], { ...layout.brushes[1], id: "floor-1" }],
      interaction_bindings: [{
        interaction: "unlock-gate",
        brush: "missing-gate",
      }],
    }).map(({ code }) => code),
    ["DUPLICATE_BRUSH_ID", "MISSING_BOUND_BRUSH"],
  );
});

Deno.test("layout parsing rejects nonsemantic material identities", () => {
  const source = JSON.parse(serialize_adventure_layout(layout));
  source.brushes[0].material = "/assets/floor.png";
  assertThrows(
    () => parse_adventure_layout(JSON.stringify(source)),
    Error,
    'material "/assets/floor.png" is unsupported',
  );
});
