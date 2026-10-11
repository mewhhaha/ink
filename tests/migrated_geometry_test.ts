import { assertAlmostEquals, assertEquals } from "@std/assert";
import { compile } from "./support.ts";

for (const name of ["brush", "daylight", "interface_orbit", "gizmos"]) {
  const entry = new URL(`./migrated_geometry_${name}.blot`, import.meta.url);
  const fixture = await compile(entry);
  const source = await Deno.readTextFile(entry);
  for (const match of source.matchAll(/entry const (test_\w+)/g)) {
    Deno.test(match[1].replaceAll("_", " "), () => {
      const result = fixture.guest.call(match[1], null) as Float32Array;
      assertEquals(result[1], 0, JSON.stringify(Array.from(result)));
    });
  }
  Deno.test.afterAll(() => fixture.dispose());
}

const fixture = await compile(
  new URL("./migrated_geometry.blot", import.meta.url),
);
const { guest } = fixture;
Deno.test("analytic ground connections reject thin box/circle crossings and allow tangencies", () => {
  assertEquals(Array.from(guest.call("clear_segments", null) as Float32Array), [
    0,
    0,
    1,
    1,
    1,
    0,
  ]);
  const moved = guest.call("thin_step", null) as Float32Array;
  assertEquals(moved[0], 1);
  assertEquals(moved[3], 1);
  assertEquals(moved[1] < 0.11, true);
});
Deno.test("brush construction rejects unbounded and invalid geometry before combinatorial work", () => {
  for (const count of [0, 3, 22, 1000]) {
    assertEquals(guest.call("bad_brush", count), 0);
  }
  assertEquals(guest.call("unbounded_brush", null), true);
  for (const value of [NaN, Infinity, -Infinity]) {
    assertEquals(guest.call("invalid_brush", value), true);
  }
});
Deno.test("path sampling resolves short segments and rejects nonfinite points", () => {
  const found = guest.call("small_path", null) as Float32Array;
  assertAlmostEquals(found[0], 0.000005, 1e-10);
  assertAlmostEquals(found[1], Math.PI / 2, 1e-6);
  for (const value of [NaN, Infinity, -Infinity]) {
    assertEquals(guest.call("invalid_path", value), true);
  }
});
Deno.test("polar grid uses caller center and exact open outer boundary", () => {
  assertEquals(
    Array.from(guest.call("polar_boundaries", null) as Uint32Array),
    [999, 0, 0, 1, 2, 999, 16],
  );
  assertEquals(guest.call("polar_roundtrip", null), 66);
  assertEquals(Array.from(guest.call("plots", 64) as Uint32Array), [64, 64]);
});
Deno.test("geometry workloads execute stable numerical witnesses", () => {
  assertEquals(Array.from(guest.call("brushes", 64) as Float32Array), [
    512,
    2080,
  ]);
  assertEquals(Array.from(guest.call("ground_segments", 64) as Uint32Array), [
    64,
    64,
  ]);
  assertEquals(Array.from(guest.call("gizmos_graphics", 64) as Float32Array), [
    1152,
    131072,
    66.625,
  ]);
  assertEquals(Array.from(guest.call("picking_view", 64) as Float32Array), [
    64,
    256,
    36160,
  ]);
  const light = guest.call("lighting", 64) as Float32Array;
  assertEquals(light[0], 64);
  assertAlmostEquals(light[1], 64.7443695, 1e-4);
  const route = guest.call("paths", 64) as Float32Array;
  assertEquals(route[0], 7);
  assertAlmostEquals(route[1], 286.83194, 1e-4);
  const orbit = guest.call("orbits", 64) as Float32Array;
  assertEquals(orbit.every(Number.isFinite), true);
  assertEquals(Math.hypot(orbit[0], orbit[2]) <= 10.001, true);
  assertAlmostEquals(orbit[4], 0.6320015, 1e-5);
});
Deno.test("editor vertical-edit plane uses caller lens while rendering remains scoped", () => {
  for (const far of [7, 60]) {
    const result = guest.call("editor_level_plane", far) as Float32Array;
    assertEquals(Array.from(result), [13, far, Math.fround(0.001), far, 3, 5]);
  }
});
Deno.test.afterAll(() => fixture.dispose());
