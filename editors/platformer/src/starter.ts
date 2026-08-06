import type { EditorPresetId } from "@ink/authoring/identity.ts";
import {
  platformer_layer_id,
  platformer_level_id,
  platformer_project_id,
  platformer_record_id,
} from "./identity.ts";
import { platformer_project, type PlatformerProject } from "./model.ts";
import { platformer_preset } from "./presets.ts";

export function create_platformer_starter(
  preset_id: EditorPresetId | string = "classic-adventure",
): PlatformerProject {
  const selected = platformer_preset(preset_id);
  const level_id = platformer_level_id("first-steps");
  return platformer_project({
    schema_version: 1,
    id: platformer_project_id("platformer-starter"),
    name: `${selected.label} starter`,
    preset_id: selected.id,
    movement: selected.movement,
    camera: selected.camera,
    default_mechanics: selected.default_mechanics,
    entry_level_id: level_id,
    levels: [{
      id: level_id,
      name: "First steps",
      bounds: { minimum: { x: 0, y: 0 }, maximum: { x: 32, y: 18 } },
      kill_plane_y: -6,
      layers: [{
        id: platformer_layer_id("collision"),
        name: "Collision",
        kind: "collision",
        depth: 0,
        records: [{
          id: platformer_record_id("ground"),
          name: "Ground",
          kind: "platform",
          bounds: { minimum: { x: 0, y: 0 }, maximum: { x: 32, y: 2 } },
          surface: "solid",
          friction: 0.8,
        }, {
          id: platformer_record_id("step"),
          name: "First step",
          kind: "platform",
          bounds: { minimum: { x: 10, y: 3 }, maximum: { x: 16, y: 4 } },
          surface: "one_way",
          friction: 0.8,
        }],
      }, {
        id: platformer_layer_id("gameplay"),
        name: "Gameplay",
        kind: "gameplay",
        depth: 1,
        records: [{
          id: platformer_record_id("player-spawn"),
          name: "Player spawn",
          kind: "spawn",
          position: { x: 3, y: 2 },
          facing: "right",
        }, {
          id: platformer_record_id("level-exit"),
          name: "Level exit",
          kind: "exit",
          bounds: { minimum: { x: 28, y: 2 }, maximum: { x: 31, y: 6 } },
          destination: { type: "complete" },
        }],
      }],
      connections: [],
    }],
  });
}
