import { assertAlmostEquals, assertEquals } from "@std/assert";
import { compile } from "./support.ts";
const fixture = await compile(new URL("./audio.blot", import.meta.url));
const mix = (x: number, velocity = 0, blocked = 0) =>
  fixture.guest.call(
    "mix",
    new Float32Array([x, velocity, blocked]),
  ) as Float32Array;
Deno.test("spatial audio has finite reach, directional pan and bounded Doppler", () => {
  assertEquals(Array.from(mix(0)), [1, 0, 1, 20000]);
  assertEquals(mix(1)[1], 1);
  assertEquals(mix(-1)[1], -1);
  assertEquals(mix(100)[0], 0);
  assertEquals(mix(1000)[0], 0);
  assertAlmostEquals(mix(10)[0], 90 / 99 / 10, 1e-7);
  assertEquals(mix(10, -50)[2] > 1, true);
  assertEquals(mix(10, 50)[2] < 1, true);
  assertEquals(mix(10, -1000)[2], 2);
  assertEquals(mix(NaN).length, 0);
});
Deno.test("solid scene geometry attenuates and filters spatial sound", () => {
  const clear = fixture.guest.call("occlusion", false) as Float32Array;
  const blocked = fixture.guest.call("occlusion", true) as Float32Array;
  assertAlmostEquals(blocked[0], clear[0] * 0.25, 1e-7);
  assertEquals(blocked[3], 1200);
  assertEquals(clear[3], 20000);
});
Deno.test("fade is a caller-timed clamped envelope", () => {
  for (
    const [elapsed, expected] of [[0, 0], [0.25, 0.25], [1, 1], [2, 1], [-1, 0]]
  ) assertEquals(fixture.guest.call("fade", elapsed), expected);
});
Deno.test.afterAll(() => fixture.dispose());
