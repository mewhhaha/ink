import { assertEquals } from "@std/assert";
import { compile } from "./support.ts";
const fixture = await compile(
  new URL("./prepared-physics.blot", import.meta.url),
);
Deno.test("prepared static worlds preserve contact order, warm starts, CCD and walker queries", () => {
  for (let mode = 0; mode < 56; mode++) {
    assertEquals(
      fixture.guest.call("actual", mode),
      fixture.guest.call("expected", mode),
    );
  }
  assertEquals(
    fixture.guest.call("query_composition", null),
    new Uint32Array([20, 0, 30, 2, 1, 20, 10]),
  );
  assertEquals(
    fixture.guest.call("invalid_static", null),
    new Uint32Array([0, 0]),
  );
  for (const count of [0, 8, 256, 2048]) {
    assertEquals(
      fixture.guest.call("workload", count),
      fixture.guest.call("reference", count),
    );
    for (const prefix of ["walker_", "joint_"]) {
      assertEquals(
        fixture.guest.call(`${prefix}workload`, count),
        fixture.guest.call(`${prefix}reference`, count),
      );
    }
  }
});
Deno.test.afterAll(() => fixture.dispose());
