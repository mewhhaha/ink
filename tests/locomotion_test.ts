import { assertEquals } from "@std/assert";
import { compile } from "./support.ts";

Deno.test("ground locomotion arrives without cargo and handles a zero timestep", async () => {
  const fixture = await compile(new URL("./locomotion.blot", import.meta.url));
  try {
    assertEquals(
      Array.from(fixture.guest.call("trips", null) as Float32Array),
      [1, 1, 0, 1, 1],
    );
  } finally {
    await fixture.dispose();
  }
});
