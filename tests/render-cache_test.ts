import { assertEquals } from "@std/assert";
import { compile } from "./support.ts";
const fixture = await compile(new URL("./render-cache.blot", import.meta.url));
Deno.test("retained draws survive edits, despawns, append, shrink and repeated dirty slots", () => {
  const old = Array.from({ length: 70 }, (_, i) => [i, i, 1]).flat();
  const after = Array.from({ length: 71 }, (_, i) => i).filter((i) =>
    i !== 2 && i !== 69
  ).flatMap((i) =>
    i === 0 ? [700, 0, 9] : [i, i === 32 ? 82 : i === 70 ? 999 : i, 1]
  );
  const smaller = after.slice(0, 32 * 3);
  assertEquals(
    fixture.guest.call("edits", null),
    new Float32Array([...old, ...after, ...smaller]),
  );
});
Deno.test("retained frame witnesses include every interpolation step and preserve the old frame", () => {
  for (
    const [entry, divisor] of [["static_frames", 0], ["sparse_frames", 100], [
      "moving_frames",
      1,
    ]] as const
  ) {
    for (const count of [128, 1024]) {
      const changing = divisor ? Math.floor(count / divisor) : 0;
      let sum = 0;
      for (let frame = 0; frame < 16; frame++) {
        const alpha = Math.fround(frame / 15);
        for (let i = 0; i < count; i++) {
          sum = Math.fround(
            sum + Math.fround(i + (i < changing ? Math.fround(2 * alpha) : 0)),
          );
        }
      }
      assertEquals(
        fixture.guest.call(entry, count),
        new Float32Array([16 * count, sum, 0]),
      );
    }
  }
});
Deno.test.afterAll(() => fixture.dispose());
