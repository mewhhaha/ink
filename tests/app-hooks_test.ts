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

Deno.test("system observation brackets every stage and guard without changing world behavior", () => {
  const calls: number[] = [];
  const result = fixture.guest.call(
    "observed_calls",
    fixture.guest.capability({
      parameter: "U32",
      result: "U32",
      call: (code: number) => {
        calls.push(code);
        return 0;
      },
    }),
  ) as Float32Array;
  assertEquals(Array.from(result), [11, 1, 2, 3, 4, 4, 5, 6]);
  assertEquals(calls, [
    4,
    5,
    100,
    101,
    206,
    207,
    308,
    309,
    410,
    411,
    414,
    415,
    410,
    411,
    414,
    415,
    512,
    513,
    602,
    603,
  ]);
});

Deno.test("plugin naming keeps prior labels and empty overrides while labeling appended systems", () => {
  assertEquals(
    Array.from(fixture.guest.call("named_plugins", null) as Uint32Array),
    [50, 77, 101],
  );
});
