import { assertEquals, assertThrows } from "@std/assert";
import { specialized_editor_descriptor } from "./catalog.ts";
import {
  editor_preset_id,
  editor_tool_id,
  specialized_editor_id,
} from "./identity.ts";

Deno.test("specialized editor descriptors preserve creator vocabulary and presets", () => {
  const descriptor = specialized_editor_descriptor({
    id: specialized_editor_id("platformer"),
    label: "Platformer",
    summary: "Place platforms and wire level logic.",
    vocabulary: ["platform", "checkpoint", "hazard"],
    tools: [{
      id: editor_tool_id("place-platform"),
      label: "Platform",
      purpose: "Place a walkable platform.",
    }],
    presets: [{
      id: editor_preset_id("precision"),
      label: "Precision",
      summary: "Tight movement and fast retries.",
      characteristic_mechanics: ["air control", "instant restart"],
    }],
  });
  assertEquals(descriptor.tools[0].label, "Platform");
  assertEquals(descriptor.presets[0].id, editor_preset_id("precision"));
});

Deno.test("specialized editor descriptors reject duplicate tool identities", () => {
  const tool = {
    id: editor_tool_id("place-platform"),
    label: "Platform",
    purpose: "Place a platform.",
  } as const;
  assertThrows(
    () =>
      specialized_editor_descriptor({
        id: specialized_editor_id("platformer"),
        label: "Platformer",
        summary: "Build levels.",
        vocabulary: ["platform"],
        tools: [tool, tool],
        presets: [{
          id: editor_preset_id("precision"),
          label: "Precision",
          summary: "Tight movement.",
          characteristic_mechanics: [],
        }],
      }),
    Error,
    "repeats place-platform",
  );
});
