import { assertEquals } from "@std/assert";
import { compile } from "./support.ts";
Deno.test("saved world tasks survive restore and reject old lifetimes; previews cannot consume them", async () => {
  const fixture = await compile(new URL("./task_world.blot", import.meta.url));
  try {
    assertEquals(
      fixture.guest.call("lifecycle", null),
      new Uint32Array([1, 1, 0, 0, 10, 11, 20, 22, 10, 11, 20, 22]),
    );
  } finally {
    await fixture.dispose();
  }
});
