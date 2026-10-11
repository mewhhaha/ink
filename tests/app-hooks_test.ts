import { assertEquals } from "@std/assert";
import { compile } from "./support.ts";
const fixture = await compile(new URL("./app-hooks.blot", import.meta.url));
Deno.test("routing precedes interface events, unpause consumes its event, catch-up and render hooks preserve order", () => {
  assertEquals(
    Array.from(fixture.guest.call("pause_events", null) as Float32Array),
    [
      11,
      2,
      0,
      0.5,
      0,
      1,
      2,
      1,
      2,
      1,
      2,
      3,
      4,
      4,
      5,
      6,
    ],
  );
});
Deno.test("paused application keeps wall time and presentation but stops simulation", () => {
  assertEquals(
    Array.from(fixture.guest.call("paused_frame", null) as Float32Array),
    [
      11,
      0,
      0,
      0.5,
      1,
      2,
      5,
      6,
    ],
  );
});
Deno.test.afterAll(() => fixture.dispose());
