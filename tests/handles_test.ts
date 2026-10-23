import { assertEquals } from "@std/assert";
import { compile } from "./support.ts";

const fixture = await compile(new URL("./handles.blot", import.meta.url));
const { guest } = fixture;
Deno.test("handles survive unrelated removal, compaction, persistence and divergent histories", () => {
  assertEquals(Array.from(guest.call("lifecycle", null) as Uint32Array), [
    10,
    999,
    30,
    20,
    40,
    999,
    999,
    50,
    999,
    40,
    10,
    30,
    40,
  ]);
  assertEquals(guest.call("exhaustion", null), 1);
});
Deno.test("store decoding rejects broken indirection, duplicate free slots and malformed frames", () => {
  const saved = guest.call("saved", null) as Uint32Array;
  assertEquals(guest.call("decode_saved", saved), 1);
  for (let end = 0; end < saved.length; end++) {
    assertEquals(guest.call("decode_saved", saved.slice(0, end)), 0);
  }
  assertEquals(guest.call("decode_saved", new Uint32Array([...saved, 0])), 0);
  for (
    const [index, value] of [
      [0, 2],
      [3, 1],
      [4, 0xffffffff],
      [5, 4],
      [10, 2],
      [19, 999],
      [20, 0],
      [21, 0],
    ]
  ) {
    const bad = saved.slice();
    bad[index] = value;
    assertEquals(guest.call("decode_saved", bad), 0, `corruption at ${index}`);
  }
});
Deno.test("building and delivery-target churn keeps old snapshots and exact ids", () => {
  for (const n of [0, 1, 32, 128, 1024]) {
    const live = Math.ceil(n / 2);
    assertEquals(Array.from(guest.call("workload", n) as Uint32Array), [
      live,
      live * (live - 1),
      n * (n - 1) / 2,
    ]);
  }
});
Deno.test("handle and dense-reference churn agree", () => {
  for (const n of [1, 3, 64, 256, 1024]) {
    assertEquals(
      fixture.guest.call("dense_churn", n),
      fixture.guest.call("workload", n),
    );
  }
});
Deno.test.afterAll(() => fixture.dispose());
