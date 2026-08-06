import { specialized_editor_descriptor } from "@ink/authoring/catalog.ts";
import {
  editor_preset_id,
  editor_tool_id,
  specialized_editor_id,
} from "@ink/authoring/identity.ts";
import type { StrategyProject } from "./model.ts";

export const strategy_editor = specialized_editor_descriptor({
  id: specialized_editor_id("strategy"),
  label: "Strategy",
  summary: "Shape maps, economies, forces, routes, waves, and objectives.",
  vocabulary: [
    "faction",
    "resource",
    "wave",
    "objective",
    "production",
    "route",
  ],
  tools: [
    ["paint-map", "Map", "Paint playable terrain and build restrictions."],
    [
      "place-structure",
      "Structure",
      "Place production, defense, or objective structures.",
    ],
    ["draw-route", "Route", "Draw movement and logistics routes."],
    ["add-wave", "Wave", "Schedule a force along a route."],
    ["edit-economy", "Economy", "Connect resources and production."],
    ["set-objective", "Objective", "Define a visible victory condition."],
  ].map(([id, label, purpose]) => ({ id: editor_tool_id(id), label, purpose })),
  presets: [
    [
      "tower-defense",
      "Tower Defense",
      "Routes, waves, build pads, and a defended core.",
      ["wave schedule", "tower placement", "route pressure"],
    ],
    [
      "real-time-strategy",
      "Real-time Strategy",
      "Economy, production, factions, and battlefield control.",
      ["resource gathering", "unit production", "base attack"],
    ],
    [
      "tactics",
      "Tactics",
      "Turn-sized encounters with cover and explicit objectives.",
      ["turn order", "cover", "mission objectives"],
    ],
    [
      "city-builder",
      "City Builder",
      "Infrastructure, needs, services, and growth.",
      ["zoning", "services", "population needs"],
    ],
    [
      "automation",
      "Automation",
      "Production graphs, logistics routes, and throughput.",
      ["recipes", "conveyance", "bottleneck inspection"],
    ],
  ].map(([id, label, summary, characteristic_mechanics]) => ({
    id: editor_preset_id(id as string),
    label: label as string,
    summary: summary as string,
    characteristic_mechanics: characteristic_mechanics as string[],
  })),
});

export function create_strategy_starter(preset: string): StrategyProject {
  const selected = strategy_editor.presets.find(({ id }) => id === preset);
  if (selected === undefined) {
    throw new Error(`strategy preset ${JSON.stringify(preset)} is unavailable`);
  }
  const route = {
    id: "route-main",
    points: [{ x: 0, y: 8 }, { x: 24, y: 8 }],
  } as const;
  return Object.freeze({
    title: `${selected.label} Starter`,
    preset: selected.id,
    width: 24,
    height: 16,
    resources: Object.freeze(["credits"]),
    factions: Object.freeze(
      [
        { id: "player", name: "Player", relation: "player" },
        { id: "opponent", name: "Opponent", relation: "opponent" },
      ] as const,
    ),
    structures: Object.freeze([
      {
        id: "home",
        kind: "headquarters",
        faction: "player",
        position: { x: 2, y: 8 },
      },
      {
        id: "target",
        kind: "headquarters",
        faction: "opponent",
        position: { x: 22, y: 8 },
      },
    ]),
    routes: Object.freeze([route]),
    waves: Object.freeze([{
      id: "wave-1",
      route: route.id,
      faction: "opponent",
      unit: "scout",
      count: 4,
      starts_at_seconds: 5,
    }]),
    objectives: Object.freeze([{
      id: "win",
      text: "Destroy the opposing headquarters",
      condition: "destroy-target" as const,
      target: "target",
    }]),
  });
}
