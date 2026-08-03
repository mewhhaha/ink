import type { GameAction, GameObservation } from "@ink/engine/protocol.ts";
import { Program, run } from "@mewhhaha/typeclasses";

interface CityPointerInput {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly observation: GameObservation;
}

export interface CityTool {
  readonly id: string;
  readonly label: string;
  readonly selected: boolean;
  readonly action: GameAction;
}

const map_columns = 32;
const tile_half_width = 0.72;
const tile_half_height = 0.36;
const map_origin_y = -11.16;

export function city_tools(
  observation: GameObservation | undefined,
): readonly CityTool[] {
  return run(Program(function* () {
    if (!observation) return [];
    return observation.actions.flatMap((description) => {
      if (!description.id.startsWith("city-tool-")) return [];
      const selected = description.action.type === "custom" &&
        description.action.value === 1;
      return [{
        id: description.id,
        label: description.label,
        selected,
        action: description.action,
      }];
    });
  }));
}

export function city_pointer_action(
  input: CityPointerInput,
): GameAction | undefined {
  return run(Program(function* () {
    const paint = input.observation.actions.find((description) =>
      description.id === "city-paint-tile"
    );
    if (paint?.action.type !== "custom") return undefined;

    const world_scale = 70 * input.observation.camera_zoom;
    const world_x = (input.x - input.width / 2) / world_scale;
    const world_y = -(input.y - input.height / 2) / world_scale;
    const column_minus_row = world_x / tile_half_width;
    const column_plus_row = (world_y - map_origin_y) / tile_half_height;
    const column = Math.round((column_plus_row + column_minus_row) / 2);
    const row = Math.round((column_plus_row - column_minus_row) / 2);
    if (column < 0 || column >= map_columns || row < 0 || row >= map_columns) {
      return undefined;
    }

    return {
      ...paint.action,
      target: row * map_columns + column,
    };
  }));
}
