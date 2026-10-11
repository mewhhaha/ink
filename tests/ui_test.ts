import { assertEquals } from "@std/assert";
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
  Deno.test.afterAll(() => fixture.dispose());
}
