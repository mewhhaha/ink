import { specialized_editor_descriptor } from "@ink/authoring/catalog.ts";
import {
  editor_preset_id,
  editor_tool_id,
  specialized_editor_id,
} from "@ink/authoring/identity.ts";

export const vehicle_presets = [
  {
    id: editor_preset_id("racer"),
    label: "Racer",
    summary: "Lap courses, checkpoints, opponents, and split times.",
    characteristic_mechanics: [
      "lap timing",
      "racing line",
      "checkpoint order",
    ],
  },
  {
    id: editor_preset_id("arcade-flight"),
    label: "Arcade Flight",
    summary: "Three-dimensional routes, targets, and boost gates.",
    characteristic_mechanics: ["flight path", "target run", "boost gate"],
  },
  {
    id: editor_preset_id("submarine"),
    label: "Submarine",
    summary: "Depth routes, sonar contacts, pressure, and objectives.",
    characteristic_mechanics: ["depth control", "sonar", "pressure hazard"],
  },
  {
    id: editor_preset_id("space-combat"),
    label: "Space Combat",
    summary: "Zero-gravity routes, formations, and combat objectives.",
    characteristic_mechanics: [
      "six-axis motion",
      "formation",
      "target objective",
    ],
  },
] as const;

export const vehicle_editor = specialized_editor_descriptor({
  id: specialized_editor_id("vehicle"),
  label: "Vehicle",
  summary:
    "Shape courses, routes, vehicles, checkpoints, hazards, and objectives.",
  vocabulary: [
    "vehicle",
    "course",
    "waypoint",
    "checkpoint",
    "hazard",
    "objective",
  ],
  tools: [
    {
      id: editor_tool_id("place-vehicle"),
      label: "Vehicle",
      purpose: "Choose and place the player's vehicle.",
    },
    {
      id: editor_tool_id("draw-course"),
      label: "Course",
      purpose: "Draw an ordered route through space.",
    },
    {
      id: editor_tool_id("place-checkpoint"),
      label: "Checkpoint",
      purpose: "Add an ordered course checkpoint.",
    },
    {
      id: editor_tool_id("place-hazard"),
      label: "Hazard",
      purpose: "Attach an obstacle or threat to the route.",
    },
    {
      id: editor_tool_id("set-objective"),
      label: "Objective",
      purpose: "Choose the scenario completion rule.",
    },
  ],
  presets: vehicle_presets,
});
