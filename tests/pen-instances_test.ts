import { assertEquals } from "@std/assert";
import { compile } from "./support.ts";
const fixture = await compile(
  new URL("./pen-instances.blot", import.meta.url),
  { "pen/": new URL("./fixtures/pen/", import.meta.url) },
);
Deno.test("retained instance packets preserve full U32 identities and encode only dirty draws", () => {
  const packet = fixture.guest.call("packet", 2) as Float32Array;
  assertEquals(Array.from(packet.slice(146, 150)), [1, 1, 2, 1]);
  assertEquals(packet.length, 150 + 2 * 26 + 2);
  assertEquals(Array.from(packet.slice(150, 155)), [65535, 65535, 0, 0, 0]);
  assertEquals(Array.from(packet.slice(176, 181)), [65534, 65535, 1, 0, 0]);
  assertEquals(Array.from(packet.slice(-2)), [1, 256]);
  assertEquals(fixture.guest.call("unsupported", null), false);
  for (const count of [1, 256, 4096]) {
    const retained = fixture.guest.call("retained", count) as Float32Array;
    const immediate = fixture.guest.call("immediate", count) as Float32Array;
    assertEquals(
      retained[0],
      16 * 150 + 26 * (count + 15 * Math.floor(count / 100)),
    );
    assertEquals(immediate[0], 16 * (150 + 24 * count));
    assertEquals(retained[1], immediate[1]);
  }
});
Deno.test.afterAll(() => fixture.dispose());
