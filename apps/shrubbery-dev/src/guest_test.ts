import { assertEquals } from "@std/assert";
import { run_shrubbery_guest } from "./guest.ts";

Deno.test("Blot shrubbery selection changes the emitted voxel recipe", async () => {
  const wasm = await Deno.readFile("generated/shrubbery.wasm");
  const oak = await run_shrubbery_guest(wasm, 2, 424_242);
  const flowers = await run_shrubbery_guest(wasm, 4, 424_242);

  assertEquals(oak.selected.name, "oak");
  assertEquals(flowers.selected.name, "flower patch");
  assertEquals(oak.voxels.length > flowers.voxels.length, true);
  assertEquals(oak.options.length, 5);
});
