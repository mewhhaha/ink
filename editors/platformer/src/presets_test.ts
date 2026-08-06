import { assertEquals, assertThrows } from "@std/assert";
import { platformer_editor_descriptor } from "./descriptor.ts";
import { list_platformer_presets, platformer_preset } from "./presets.ts";
import { create_platformer_starter } from "./starter.ts";
import { validate_platformer_project } from "./validation.ts";

Deno.test("eight platformer presets have distinct movement, camera, and mechanic defaults", () => {
  const presets = list_platformer_presets();
  assertEquals(presets.map(({ id }) => id), [
    "classic-adventure",
    "precision",
    "momentum",
    "aerial-acrobatics",
    "exploration",
    "auto-runner",
    "puzzle-platformer",
    "cinematic-chase",
  ]);
  assertEquals(
    new Set(presets.map(({ movement }) => JSON.stringify(movement))).size,
    8,
  );
  assertEquals(
    new Set(presets.map(({ camera }) => JSON.stringify(camera))).size,
    8,
  );
  assertEquals(
    new Set(
      presets.map(({ default_mechanics }) => JSON.stringify(default_mechanics)),
    ).size,
    8,
  );
  for (const preset of presets) {
    assertEquals(
      validate_platformer_project(create_platformer_starter(preset.id)),
      [],
    );
  }
});

Deno.test("platformer preset lookup reports the unknown identity", () => {
  assertEquals(platformer_preset("momentum").camera.mode, "forward_focus");
  assertThrows(
    () => platformer_preset("missing"),
    Error,
    'platformer preset "missing" does not exist',
  );
});

Deno.test("editor descriptor exposes genre vocabulary, tools, and all presets", () => {
  assertEquals(platformer_editor_descriptor.id, "platformer");
  assertEquals(platformer_editor_descriptor.presets.length, 8);
  assertEquals(
    platformer_editor_descriptor.tools.some(({ id }) => id === "connect-logic"),
    true,
  );
  assertEquals(
    platformer_editor_descriptor.vocabulary.includes("moving path"),
    true,
  );
});
