import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { createCompiler } from "@mewhhaha/blot";
import { instantiateGuest } from "@mewhhaha/blot/guest";
import { libraryUrl } from "./mod.ts";

// A 8 x 5 map: ground in row 0, a wall at x = 6 (rows 1-2), a one-way plank at
// (2..3, 2), a ladder at x = 4 (rows 1-3), spikes at (1, 1), a ceiling block
// at (0, 4). Tile ids: 1 solid, 2 one-way, 3 ladder, 4 hazard.
const W = 8, H = 5;
const cells = new Array<number>(W * H).fill(0);
const put = (x: number, y: number, id: number) => (cells[y * W + x] = id);
for (let x = 0; x < W; x++) put(x, 0, 1);
put(6, 1, 1);
put(6, 2, 1);
put(2, 2, 2);
put(3, 2, 2);
for (const y of [1, 2, 3]) put(4, y, 3);
put(1, 1, 4);
put(0, 4, 1);

const source = `import * as array from "std/array"
import { Vec2 } from "std/vector"
import * as tiles from "ink/tiles"

// lanes: x, y, vx, vy, drop, dt, half x, half y, then the cells
entry const probe = fn (lanes: Array F32) -> Array F32 => do:
  let cells = array.map (fn (v: F32) => F32.to_u32 v) (array.slice 8 ${
  W * H
} lanes)
  let g = tiles.grid ${W} ${H} (#Vec2 { x: 1.0, y: 1.0 }) (#Vec2 { x: 0.0, y: 0.0 }) cells #[0, 1, 2, 4, 8]
  let half = #Vec2 { x: lanes[6], y: lanes[7] }
  let p = #Vec2 { x: lanes[0], y: lanes[1] }
  let m = tiles.slide g half (lanes[4] > 0.5) p (#Vec2 { x: lanes[2], y: lanes[3] }) lanes[5]
  let ladder = if tiles.touches g tiles.ladder p half then 1.0 else 0.0
  let hazard = if tiles.touches g tiles.hazard p half then 1.0 else 0.0
  let tile = U32.to_f32 (tiles.tile_at g (floor p.x) (floor p.y))
  return #[m.pos.x, m.pos.y, m.vel.x, m.vel.y, (if m.grounded then 1.0 else 0.0), m.wall, (if m.head then 1.0 else 0.0), ladder, hazard, tile]
`;

const dir = await Deno.makeTempDir({ prefix: "ink-tiles-" });
const entry = join(dir, "main.blot");
await Deno.writeTextFile(entry, source);
const compiler = await createCompiler({
  entry,
  imports: { "ink/": fromFileUrl(libraryUrl) },
});
const built = await compiler.build();
assert(built.success, JSON.stringify(built));
const guest = await instantiateGuest(built.bytes);

function slide(
  x: number,
  y: number,
  vx: number,
  vy: number,
  options: { drop?: boolean; dt?: number; half?: [number, number] } = {},
) {
  const half = options.half ?? [0.4, 0.5];
  const lanes = new Float32Array([
    x,
    y,
    vx,
    vy,
    options.drop ? 1 : 0,
    options.dt ?? 1 / 60,
    half[0],
    half[1],
    ...cells,
  ]);
  const out = guest.call("probe", lanes) as Float32Array;
  return {
    x: out[0],
    y: out[1],
    vx: out[2],
    vy: out[3],
    grounded: out[4] === 1,
    wall: out[5],
    head: out[6] === 1,
    ladder: out[7] === 1,
    hazard: out[8] === 1,
    tile: out[9],
  };
}

Deno.test("a box falls onto the ground and stops on it", () => {
  const r = slide(3.5, 1.52, 0, -10);
  assert(r.grounded);
  assertAlmostEquals(r.y, 1.5, 0.002);
  assertEquals(r.vy, 0);
});

Deno.test("walls stop sideways motion from both directions", () => {
  const right = slide(5.55, 1.5, 6, 0);
  assertEquals(right.wall, 1);
  assertEquals(right.vx, 0);
  assert(right.x + 0.4 <= 6.0, `x = ${right.x}`);
  const left = slide(7.45, 1.5, -6, 0);
  assertEquals(left.wall, -1);
  assert(left.x - 0.4 >= 7.0 - 1e-3, `x = ${left.x}`);
  // A box standing on the floor does not catch on it while walking.
  assertEquals(slide(3, 1.5, 3, 0).wall, 0);
});

Deno.test("heads bump into undersides", () => {
  const r = slide(0.5, 3.45, 0, 8);
  assert(r.head);
  assertEquals(r.vy, 0);
  assert(r.y + 0.5 <= 4.0 + 1e-3);
});

Deno.test("one-way planks hold from above and let you through from below", () => {
  const landing = slide(2.5, 3.52, 0, -8);
  assert(landing.grounded, "lands on the plank");
  assertAlmostEquals(landing.y, 3.5, 0.002);
  const jumping = slide(2.5, 2.2, 0, 12);
  assert(!jumping.head, "passes up through it");
  assert(jumping.y > 2.2);
  const dropping = slide(2.5, 3.5, 0, -2, { drop: true });
  assert(!dropping.grounded, "drops through when asked");
});

Deno.test("tiles can be asked about: ladders, hazards and ids", () => {
  assert(slide(4.5, 2.5, 0, 0).ladder);
  assert(!slide(5.5, 2.5, 0, 0).ladder);
  assert(slide(1.5, 1.5, 0, 0, { half: [0.3, 0.3] }).hazard);
  assertEquals(slide(2.5, 2.5, 0, 0).tile, 2);
  assertEquals(slide(-3, 2.5, 0, 0).tile, 0, "outside the map is empty");
});

Deno.test.afterAll(async () => {
  guest.dispose();
  await compiler.dispose();
  await Deno.remove(dir, { recursive: true });
});
