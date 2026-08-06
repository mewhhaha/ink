import {
  coordinate_random,
  generator_revision,
  procedural_seed,
} from "./identity.ts";
import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";

Deno.test("coordinate random values are stable for a seed, revision, coordinate, and channel", () => {
  const seed = procedural_seed(42n);
  const revision = generator_revision("terrain-v1");
  assertEquals(
    coordinate_random(seed, revision, [3, -7], "height"),
    coordinate_random(seed, revision, [3, -7], "height"),
  );
  assertNotEquals(
    coordinate_random(seed, revision, [3, -7], "height"),
    coordinate_random(seed, revision, [3, -7], "moisture"),
  );
});

Deno.test("procedural identities reject invalid boundary values", () => {
  assertThrows(() => procedural_seed(-1n), Error, "unsigned 64-bit");
  assertThrows(() => generator_revision("  "), Error, "cannot be empty");
  assertThrows(
    () =>
      coordinate_random(
        procedural_seed(0n),
        generator_revision("v1"),
        [0.5],
        "x",
      ),
    Error,
    "safe integer",
  );
});
