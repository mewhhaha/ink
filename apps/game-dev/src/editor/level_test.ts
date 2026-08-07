import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import {
  expand_platformer_level,
  move_player_start,
  paint_level_tile,
  parse_platformer_level,
  serialize_platformer_level,
} from "./level.ts";

const level = {
  name: "Test room",
  columns: 2,
  rows: 2,
  terrain: [0, 1, -1, 16],
  decoration: [-1, -1, 48, -1],
  player_start: 2,
  geometry: [{
    id: "collision-1",
    category: "collision",
    points: [{ x: 0, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }, {
      x: 0,
      y: 2,
    }],
  }],
} as const;

Deno.test("platformer levels round trip through their asset format", () => {
  assertEquals(
    parse_platformer_level(serialize_platformer_level(level)),
    level,
  );
});

Deno.test("area names round trip through the level asset", () => {
  const area_level = {
    ...level,
    geometry: [{
      id: "area-1",
      category: "area",
      name: "Secret passage",
      points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, {
        x: 0,
        y: 1,
      }],
    }],
  } as const;
  assertEquals(
    parse_platformer_level(serialize_platformer_level(area_level)),
    area_level,
  );
});

Deno.test("moving the player start preserves the tile layers", () => {
  const moved = move_player_start(level, 3);
  assertEquals(moved.player_start, 3);
  assertStrictEquals(moved.terrain, level.terrain);
  assertStrictEquals(moved.decoration, level.decoration);
});

Deno.test("painting changes only the selected layer and tile", () => {
  const painted = paint_level_tile(level, "terrain", 2, 3);
  assertEquals(painted.terrain, [0, 1, 3, 16]);
  assertStrictEquals(painted.decoration, level.decoration);
  assertStrictEquals(
    paint_level_tile(painted, "terrain", 2, 3),
    painted,
  );
});

Deno.test("expanding a level shifts its contents without changing their layout", () => {
  const expanded = expand_platformer_level(level, {
    left: 1,
    right: 2,
    top: 1,
    bottom: 0,
  });
  assertEquals({ columns: expanded.columns, rows: expanded.rows }, {
    columns: 5,
    rows: 3,
  });
  assertEquals(expanded.terrain, [
    -1,
    -1,
    -1,
    -1,
    -1,
    -1,
    0,
    1,
    -1,
    -1,
    -1,
    -1,
    16,
    -1,
    -1,
  ]);
  assertEquals(expanded.decoration, [
    -1,
    -1,
    -1,
    -1,
    -1,
    -1,
    -1,
    -1,
    -1,
    -1,
    -1,
    48,
    -1,
    -1,
    -1,
  ]);
  assertEquals(expanded.player_start, 11);
  assertEquals(expanded.geometry[0].points, [
    { x: 1, y: 2 },
    { x: 3, y: 2 },
    { x: 3, y: 3 },
    { x: 1, y: 3 },
  ]);
  assertEquals(
    parse_platformer_level(serialize_platformer_level(expanded)),
    expanded,
  );
});

Deno.test("expanding a level rejects dimensions beyond the asset limit", () => {
  assertThrows(
    () =>
      expand_platformer_level(level, {
        left: 0,
        right: 63,
        top: 0,
        bottom: 63,
      }),
    Error,
    "exceeding 4096 tiles",
  );
});

Deno.test("platformer levels reject truncated tile layers", () => {
  assertThrows(
    () =>
      parse_platformer_level(JSON.stringify({
        format: "blot-integer-data",
        version: 1,
        name: "Broken",
        fields: [[2], [2], [0], [-1, -1, -1, -1], [2]],
        geometry: [],
      })),
    Error,
    "terrain layer must contain 4 tiles",
  );
});

Deno.test("platformer levels reject geometry outside the level grid", () => {
  assertThrows(
    () =>
      parse_platformer_level(JSON.stringify({
        format: "blot-integer-data",
        version: 1,
        name: "Broken geometry",
        fields: [[2], [2], [0, 0, 0, 0], [-1, -1, -1, -1], [2]],
        geometry: [{
          id: "collision-1",
          category: "collision",
          points: [[0, 0], [3, 0], [0, 1]],
        }],
      })),
    Error,
    "must use quarter-tile coordinates inside 2x2",
  );
});

Deno.test("platformer levels reject unnamed areas", () => {
  assertThrows(
    () =>
      parse_platformer_level(JSON.stringify({
        format: "blot-integer-data",
        version: 1,
        name: "Unnamed area",
        fields: [[2], [2], [0, 0, 0, 0], [-1, -1, -1, -1], [2]],
        geometry: [{
          id: "area-1",
          category: "area",
          points: [[0, 0], [2, 0], [0, 1]],
        }],
      })),
    Error,
    'area "area-1" name must be nonempty',
  );
});
