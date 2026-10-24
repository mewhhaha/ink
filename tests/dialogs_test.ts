import { assertEquals } from "@std/assert";
import { compile } from "./support.ts";
for (const name of ["dialogs", "layers", "input_dispatch"]) {
  const fixture = await compile(new URL(`./${name}.blot`, import.meta.url));
  const source = await Deno.readTextFile(
    new URL(`./${name}.blot`, import.meta.url),
  );
  for (const match of source.matchAll(/entry const (test_\w+)/g)) {
    Deno.test(`${name}: ${match[1]}`, () => {
      const result = fixture.guest.call(match[1], null) as Float32Array;
      assertEquals(result[1], 0, String(Array.from(result)));
    });
  }
  Deno.test.afterAll(() => fixture.dispose());
}
