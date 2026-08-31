import { specialized_editor_descriptor } from "@ink/authoring/catalog.ts";
import {
  editor_preset_id,
  editor_tool_id,
  specialized_editor_id,
} from "@ink/authoring/identity.ts";
import {
  strategy_faction_id,
  strategy_objective_id,
  strategy_project_id,
  strategy_resource_id,
  strategy_route_id,
  strategy_structure_id,
  strategy_unit_id,
  strategy_wave_id,
} from "./identity.ts";
import {
  strategy_project,
  type StrategyProject,
  type StrategyRoute,
} from "./model.ts";

export const strategy_presets = [
  {
    id: editor_preset_id("tower-defense"),
    label: "Tower Defense",
    summary: "Routes, waves, build pads, and a defended core.",
    characteristic_mechanics: [
      "wave schedule",
      "tower placement",
      "route pressure",
    ],
  },
  {
    id: editor_preset_id("real-time-strategy"),
    label: "Real-time Strategy",
    summary: "Economy, production, factions, and battlefield control.",
    characteristic_mechanics: [
      "resource gathering",
      "unit production",
      "base attack",
    ],
  },
  {
    id: editor_preset_id("tactics"),
    label: "Tactics",
    summary: "Turn-sized encounters with cover and explicit objectives.",
    characteristic_mechanics: ["turn order", "cover", "mission objectives"],
  },
  {
    id: editor_preset_id("city-builder"),
    label: "City Builder",
    summary: "Infrastructure, needs, services, and growth.",
    characteristic_mechanics: ["zoning", "services", "population needs"],
  },
  {
    id: editor_preset_id("automation"),
    label: "Automation",
    summary: "Production graphs, logistics routes, and throughput.",
    characteristic_mechanics: [
      "recipes",
      "conveyance",
      "bottleneck inspection",
    ],
  },
] as const;

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
    {
      id: editor_tool_id("paint-map"),
      label: "Map",
      purpose: "Paint playable terrain and build restrictions.",
    },
    {
      id: editor_tool_id("place-structure"),
      label: "Structure",
      purpose: "Place production, defense, or objective structures.",
    },
    {
      id: editor_tool_id("draw-route"),
      label: "Route",
      purpose: "Draw movement and logistics routes.",
    },
    {
      id: editor_tool_id("add-wave"),
      label: "Wave",
      purpose: "Schedule a force along a route.",
    },
    {
      id: editor_tool_id("edit-economy"),
      label: "Economy",
      purpose: "Connect resources and production.",
    },
    {
      id: editor_tool_id("set-objective"),
      label: "Objective",
      purpose: "Define a visible victory condition.",
    },
  ],
  presets: strategy_presets,
});

export function create_strategy_starter(preset: string): StrategyProject {
  const selected = strategy_presets.find(({ id }) => id === preset);
  if (selected === undefined) {
    throw new Error(`strategy preset ${JSON.stringify(preset)} is unavailable`);
  }
  const player_faction_id = strategy_faction_id("player");
  const opponent_faction_id = strategy_faction_id("opponent");
  const target_structure_id = strategy_structure_id("target");
  const route: StrategyRoute = {
    id: strategy_route_id("route-main"),
    points: [{ x: 0, y: 8 }, { x: 24, y: 8 }],
  };
  return strategy_project({
    schema_version: 1,
    id: strategy_project_id("frontier-assault"),
    name: `${selected.label} Starter`,
    preset_id: selected.id,
    map: { width: 24, height: 16 },
    resources: [strategy_resource_id("credits")],
    factions: [
      { id: player_faction_id, name: "Player", relation: "player" },
      {
        id: opponent_faction_id,
        name: "Opponent",
        relation: "opponent",
      },
    ],
    structures: [
      {
        id: strategy_structure_id("home"),
        kind: "headquarters",
        faction_id: player_faction_id,
        position: { x: 2, y: 8 },
      },
      {
        id: target_structure_id,
        kind: "headquarters",
        faction_id: opponent_faction_id,
        position: { x: 22, y: 8 },
      },
    ],
    routes: [route],
    waves: [{
      id: strategy_wave_id("wave-1"),
      route_id: route.id,
      faction_id: opponent_faction_id,
      unit_id: strategy_unit_id("scout"),
      count: 4,
      starts_at_seconds: 5,
    }],
    objectives: [{
      id: strategy_objective_id("win"),
      text: "Destroy the opposing headquarters",
      condition: {
        type: "destroy_structure",
        structure_id: target_structure_id,
      },
    }],
  });
}
