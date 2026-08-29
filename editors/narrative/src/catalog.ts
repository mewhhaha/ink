import { specialized_editor_descriptor } from "@ink/authoring/catalog.ts";
import {
  editor_preset_id,
  editor_tool_id,
  specialized_editor_id,
} from "@ink/authoring/identity.ts";
export const narrative_presets = [
  {
    id: editor_preset_id("kinetic-novel"),
    label: "Kinetic novel",
    summary: "A directed story without branching choices.",
    characteristic_mechanics: ["linear scenes", "presentation", "chapters"],
  },
  {
    id: editor_preset_id("branching-vn"),
    label: "Branching visual novel",
    summary: "Choices split and reconverge through several endings.",
    characteristic_mechanics: ["choices", "variables", "endings"],
  },
  {
    id: editor_preset_id("dating-sim"),
    label: "Dating sim",
    summary: "Relationships change through scheduled choices.",
    characteristic_mechanics: ["affection", "calendar", "character routes"],
  },
  {
    id: editor_preset_id("investigation"),
    label: "Investigation",
    summary: "Evidence unlocks deductions and accusations.",
    characteristic_mechanics: ["evidence", "conditions", "deduction"],
  },
] as const;
export const narrative_editor = specialized_editor_descriptor({
  id: specialized_editor_id("narrative"),
  label: "Narrative",
  summary:
    "Author scenes, dialogue beats, decisions, story state, and endings.",
  vocabulary: [
    "scene",
    "beat",
    "choice",
    "condition",
    "variable",
    "evidence",
    "ending",
  ],
  tools: [
    "scenes",
    "beats",
    "choices",
    "conditions",
    "variables",
    "evidence",
    "endings",
  ].map((name) => ({
    id: editor_tool_id(name),
    label: name[0].toUpperCase() + name.slice(1),
    purpose: `Author narrative ${name}.`,
  })),
  presets: narrative_presets,
});
