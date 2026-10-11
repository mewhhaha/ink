import { assertEquals } from "@std/assert";
import { compile } from "./support.ts";

const entry = new URL("./app.blot", import.meta.url);
const fixture = await compile(entry);
const source = await Deno.readTextFile(entry);
for (const match of source.matchAll(/entry const (test_\w+)/g)) {
  Deno.test(match[1].replaceAll("_", " "), () => {
    const result = fixture.guest.call(match[1], null) as Float32Array;
    assertEquals(result[1], 0, JSON.stringify(Array.from(result)));
  });
}
Deno.test.afterAll(() => fixture.dispose());
