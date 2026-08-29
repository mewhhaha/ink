import type { GameAction } from "@ink/blot/protocol.ts";
import {
  type AdventureBrush,
  maximum_adventure_brushes,
} from "@ink/adventure-editor/layout.ts";
import {
  adventure_brush_field_count,
  adventure_brush_values,
} from "../project.ts";

export const adventure_project_url = "/adventure-project.json";
export const adventure_project_save_url = "/__ink/adventure-project";
export const level_edit_event = 40;
export const player_start_cell = maximum_adventure_brushes *
  adventure_brush_field_count;

const preview_value_offset = 128;

type PreviewAction = Extract<GameAction, { readonly type: "custom" }>;

export function brush_preview_updates(
  brush: AdventureBrush,
): readonly PreviewAction[] {
  return adventure_brush_values(brush).map((value, field) => ({
    type: "custom" as const,
    kind: level_edit_event,
    target: field * maximum_adventure_brushes + brush.slot,
    value: value + preview_value_offset,
  }));
}

export function remove_brush_preview_update(slot: number): PreviewAction {
  if (
    !Number.isSafeInteger(slot) || slot < 0 ||
    slot >= maximum_adventure_brushes
  ) {
    throw new Error(
      `adventure brush slot ${JSON.stringify(slot)} must be an integer in 0..${
        maximum_adventure_brushes - 1
      }`,
    );
  }
  return {
    type: "custom",
    kind: level_edit_event,
    target: slot,
    value: preview_value_offset - 1,
  };
}

export function player_start_preview_updates(
  position: { readonly x2: number; readonly z2: number },
): readonly PreviewAction[] {
  return [position.x2, position.z2].map((value, index) => ({
    type: "custom" as const,
    kind: level_edit_event,
    target: player_start_cell + index,
    value: value + preview_value_offset,
  }));
}
