import { apply_strategy_command } from "@ink/strategy-editor/commands.ts";
import {
  strategy_route_id,
  strategy_structure_id,
  strategy_unit_id,
} from "@ink/strategy-editor/identity.ts";
import type {
  StrategyProject,
  StrategyRoutePoints,
} from "@ink/strategy-editor/model.ts";

export const authored_scout_route: StrategyRoutePoints = Object.freeze([
  Object.freeze({ x: 4, y: 8 }),
  Object.freeze({ x: 8, y: 5 }),
  Object.freeze({ x: 14, y: 11 }),
  Object.freeze({ x: 22, y: 8 }),
]);

export function add_player_barracks_and_scout_route(
  project: StrategyProject,
): StrategyProject {
  const player = project.factions.find(({ relation }) => relation === "player");
  if (player === undefined) {
    throw new Error(`strategy project ${project.id} has no player faction`);
  }
  const with_barracks = apply_strategy_command(project, {
    type: "place_structure",
    structure: {
      id: strategy_structure_id("scout-barracks"),
      kind: "barracks",
      faction_id: player.id,
      position: authored_scout_route[0],
      produces_unit_id: strategy_unit_id("scout"),
    },
  });
  return apply_strategy_command(with_barracks, {
    type: "draw_route",
    route: {
      id: strategy_route_id("scout-route"),
      points: authored_scout_route,
    },
  });
}

export function expand_strategy_map_for_failed_activation(
  project: StrategyProject,
): StrategyProject {
  return apply_strategy_command(project, {
    type: "paint_map",
    map: { width: project.map.width + 4, height: project.map.height },
  });
}
