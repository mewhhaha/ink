import { assertEquals } from "@std/assert";
import { microseconds } from "@ink/runtime/identity.ts";
import { create_shrubbery_session, shrubbery_observation } from "./runtime.ts";

Deno.test("Blot shrubbery actions change the scene published by the runtime", async () => {
  const session = await create_shrubbery_session(
    await Deno.readFile("generated/shrubbery.wasm"),
    await Deno.readTextFile("generated/shrubbery.wasm.json"),
  );
  try {
    const initial = shrubbery_observation(
      await session.observe({ width: 1280, height: 720 }),
    );
    const flowers_action = initial.actions.find(({ id }) => id === "flowers")
      ?.action;
    if (flowers_action === undefined) {
      throw new Error("Blot shrubbery observation omitted flowers action");
    }
    await session.advance({
      elapsed_us: microseconds(0),
      inputs: [flowers_action],
    });
    const flowers = shrubbery_observation(
      await session.observe({ width: 1280, height: 720 }),
    );

    assertEquals(initial.selected_name, "mixed shrubbery");
    assertEquals(flowers.selected_name, "flower patch");
    assertEquals(initial.voxels.length > flowers.voxels.length, true);
    assertEquals(initial.actions.length, 6);
  } finally {
    await session.close();
  }
});
