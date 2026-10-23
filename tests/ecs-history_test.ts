import { assertEquals } from "@std/assert";
import { compile } from "./support.ts";
const fixture = await compile(new URL("./ecs-history.blot", import.meta.url));
Deno.test("sparse queries preserve order, membership changes, removed rows and old views across historical capacity", () => {
  for (const count of [64, 513, 4096, 65536]) {
    assertEquals(
      fixture.guest.call("workload", count),
      new Uint32Array([32 * (4096 - 65 - 127), 32, 132, 0]),
    );
  }
});
Deno.test.afterAll(() => fixture.dispose());
