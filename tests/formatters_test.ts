import { assert, assertEquals } from "@std/assert";
import { compile } from "./support.ts";

const fixture = await compile(new URL("./formatters.blot", import.meta.url));
const guest = fixture.guest;
const written = (entry: string, value: number) =>
  String.fromCodePoint(...guest.call(entry, value) as Uint32Array);

Deno.test("decimal formatting preserves ordinary rounding and fixed padding", () => {
  for (
    const [value, decimal, fixed, shown] of [
      [0, "0", "0.00", "0"],
      [-0, "0", "0.00", "0"],
      [2.4, "2.4", "2.40", "2.4"],
      [-12.125, "-12.125", "-12.13", "-12.125"],
      [0.0625, "0.0625", "0.06", "0.0625"],
      [9.999, "9.999", "10.00", "9.999"],
    ] as const
  ) {
    assertEquals(written("decimal", value), decimal);
    assertEquals(written("fixed", value), fixed);
    assertEquals(written("shown", value), shown);
  }
});

Deno.test("maximum precision and exponent requests have bounded output", () => {
  assertEquals(written("decimal_precision", 0xffffffff), "1.25");
  assertEquals(written("fixed_precision", 0xffffffff), "1.250000");
  assertEquals(written("fixed_precision", 0), "1");
  assertEquals(guest.call("power", 0), 1);
  assertEquals(guest.call("power", 6), 1e6);
  assert(Number.isFinite(guest.call("power", 38)));
  assertEquals(guest.call("power", 39), Infinity);
  assertEquals(guest.call("power", 0xffffffff), Infinity);
});

Deno.test("formatters label nonfinite values without integer conversion traps", () => {
  for (const entry of ["decimal", "fixed", "shown"]) {
    assertEquals(written(entry, NaN), "NaN");
    assertEquals(written(entry, Infinity), "Infinity");
    assertEquals(written(entry, -Infinity), "-Infinity");
  }
});

Deno.test("large magnitudes retain their scale with bounded scientific notation", () => {
  assertEquals(written("fixed", 100000000), "100000000.00");
  assertEquals(written("decimal", 4000000000), "4e9");
  assertEquals(written("fixed", 4000000000), "4.00e9");
  for (const value of [1e20, -1e20, 3.4028234663852886e38]) {
    const actual = Math.fround(value);
    for (const entry of ["decimal", "fixed_six", "shown"]) {
      const result = written(entry, value);
      assert(result.length <= 16, result);
      assert(result.includes("e"), result);
      assert(Math.abs(Number(result) / actual - 1) < 2e-6, result);
    }
  }
});

Deno.test("text rest clamps starts beyond the code point array", () => {
  assertEquals(written("rest", 0), "ABC");
  assertEquals(written("rest", 1), "BC");
  assertEquals(written("rest", 3), "");
  assertEquals(written("rest", 4), "");
  assertEquals(written("rest", 0xffffffff), "");
});

Deno.test.afterAll(() => fixture.dispose());
