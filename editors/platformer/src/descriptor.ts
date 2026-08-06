import { specialized_editor_descriptor } from "@ink/authoring/catalog.ts";
import {
  editor_tool_id,
  specialized_editor_id,
} from "@ink/authoring/identity.ts";
import { list_platformer_presets } from "./presets.ts";

export const platformer_editor_descriptor = specialized_editor_descriptor({
  id: specialized_editor_id("platformer"),
  label: "Platformer",
  summary:
    "Build bounded platforming levels, movement routes, and trigger-driven encounters.",
  vocabulary: [
    "level",
    "layer",
    "platform",
    "slope",
    "hazard",
    "spawn",
    "checkpoint",
    "exit",
    "collectible",
    "enemy",
    "moving path",
    "trigger zone",
    "camera zone",
  ],
  tools: [
    ["place-platform", "Platform", "Place a solid or one-way platform."],
    ["place-slope", "Slope", "Place a walkable slope."],
    ["place-hazard", "Hazard", "Mark a damaging or defeating area."],
    ["place-spawn", "Spawn", "Place the level's player spawn."],
    ["place-checkpoint", "Checkpoint", "Place a retry checkpoint."],
    ["place-exit", "Exit", "Place the level's completion or transition exit."],
    ["place-collectible", "Collectible", "Place a collectible objective."],
    ["place-enemy", "Enemy", "Place a genre-specific enemy archetype."],
    ["draw-moving-path", "Moving path", "Attach a motion route to a platform."],
    [
      "place-trigger-zone",
      "Trigger zone",
      "Place a trigger source for level logic.",
    ],
    [
      "place-camera-zone",
      "Camera zone",
      "Override framing inside a bounded area.",
    ],
    [
      "connect-logic",
      "Connect logic",
      "Connect a trigger through a condition to an action.",
    ],
  ].map(([id, label, purpose]) => ({ id: editor_tool_id(id), label, purpose })),
  presets: list_platformer_presets().map((preset) => ({
    id: preset.id,
    label: preset.label,
    summary: preset.summary,
    characteristic_mechanics: preset.characteristic_mechanics,
  })),
});
