import { assert, assertAlmostEquals } from "@std/assert";
import { compile } from "./support.ts";
Deno.test("navigation example follows the weighted field", async () => {
  const fixture = await compile(
    new URL("../examples/navigation.blot", import.meta.url),
  );
  try {
    const result = fixture.guest.call("route", 0) as Float32Array;
    assert(result[0] === 7 && result[1] === 4);
    assertAlmostEquals(result[2], 0, 1e-6);
    assert(result[3] > 0);
  } finally {
    await fixture.dispose();
  }
});
Deno.test("joint example simulates its anchored body", async () => {
  const fixture = await compile(
    new URL("../examples/joints.blot", import.meta.url),
  );
  try {
    const result = fixture.guest.call("pendulum", 16) as Float32Array;
    assertAlmostEquals(result[2], 1, 0.002);
    assert(result[1] < 2);
  } finally {
    await fixture.dispose();
  }
});
