import { specialized_editor_descriptor } from "../../../packages/authoring/src/catalog.ts";
import {
  editor_preset_id,
  editor_tool_id,
  specialized_editor_id,
} from "../../../packages/authoring/src/identity.ts";

export const roleplaying_presets = [
  {
    id: editor_preset_id("tactical-crpg"),
    label: "Tactical CRPG",
    summary: "Party tactics and consequential quests.",
    characteristic_mechanics: ["party", "turns", "dialogue checks"],
  },
  {
    id: editor_preset_id("action-rpg"),
    label: "Action RPG",
    summary: "Immediate combat with character builds.",
    characteristic_mechanics: ["real-time combat", "equipment", "skills"],
  },
  {
    id: editor_preset_id("dungeon-crawler"),
    label: "Dungeon crawler",
    summary: "A party explores dangerous connected chambers.",
    characteristic_mechanics: ["mapping", "resources", "traps"],
  },
  {
    id: editor_preset_id("roguelite"),
    label: "Roguelite",
    summary: "Repeatable runs with persistent discoveries.",
    characteristic_mechanics: ["runs", "random rewards", "metaprogression"],
  },
  {
    id: editor_preset_id("cozy-farming"),
    label: "Cozy farming",
    summary: "Relationships and seasonal cultivation.",
    characteristic_mechanics: ["farming", "calendar", "friendship"],
  },
] as const;
export const roleplaying_editor = specialized_editor_descriptor({
  id: specialized_editor_id("roleplaying"),
  label: "Role-playing",
  summary: "Author regions, characters, stories, rewards, and traversal.",
  vocabulary: [
    "region",
    "actor",
    "dialogue",
    "quest",
    "loot",
    "encounter",
    "navigation",
  ],
  tools: [
    "regions",
    "actors",
    "dialogue",
    "quests",
    "loot",
    "encounters",
    "navigation",
  ].map((name) => ({
    id: editor_tool_id(name),
    label: name[0].toUpperCase() + name.slice(1),
    purpose: `Author role-playing ${name}.`,
  })),
  presets: roleplaying_presets,
});
