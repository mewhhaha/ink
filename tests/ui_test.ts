import { assertEquals, assertThrows } from "@std/assert";
import { compile } from "./support.ts";

for (
  const name of [
    "ui_controls",
    "ui_focus",
    "ui_boundaries",
    "input",
    "preferences",
    "tune",
  ]
) {
  const fixture = await compile(new URL(`./${name}.blot`, import.meta.url));
  const source = await Deno.readTextFile(
    new URL(`./${name}.blot`, import.meta.url),
  );
  for (const match of source.matchAll(/entry const (test_\w+)/g)) {
    const entry = match[1];
    Deno.test(`${name}: ${entry}`, () => {
      const result = fixture.guest.call(entry, null) as Float32Array;
      assertEquals(result[1], 0, String(Array.from(result)));
    });
  }
  if (name === "ui_boundaries") {
    Deno.test("ui: invalid numeric controls remain bounded", () => {
      for (
        const values of [[0, NaN, 1, 0], [0, 1, -1, 0], [NaN, 0, 1, 0], [
          0,
          0,
          Infinity,
          0,
        ]]
      ) {
        const result = fixture.guest.call(
          "invalid_slider",
          new Float32Array(values),
        ) as Float32Array;
        assertEquals(Array.from(result).every(Number.isFinite), true);
      }
    });
  }
  if (name === "tune") {
    Deno.test("tune: saved settings reject a repeated id wherever it lies", () => {
      const decode = (ids: number[]) =>
        fixture.guest.call("decode_ids", new Float32Array(ids));
      assertEquals(decode([9, 3, 5]), 3);
      assertEquals(decode([]), 0);
      for (const ids of [[3, 9, 3], [4, 4], [1, 2, 3, 2]]) {
        assertThrows(() => decode(ids));
      }
    });
  }
  Deno.test.afterAll(() => fixture.dispose());
}
