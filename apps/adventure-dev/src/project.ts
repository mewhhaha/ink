import {
  type AdventureDocument,
  parse_adventure_document,
  serialize_adventure_document,
} from "@ink/adventure-editor/document.ts";
import {
  type AdventureBrush,
  type AdventureMaterialKey,
  maximum_adventure_brushes,
} from "@ink/adventure-editor/layout.ts";
import {
  type AdventureTraversalContract,
  compile_adventure_traversal,
} from "./traversal.ts";

export const adventure_brush_field_count = 9;

const brush_kinds = ["block", "door", "stairs"] as const;
const material_slots: Readonly<Record<AdventureMaterialKey, number>> = {
  "dungeon.floor.flagstone": 0,
  "dungeon.wall.limestone": 1,
  "dungeon.gate.oak": 2,
};

export interface CompiledAdventureProject {
  readonly canonical_source: string;
  readonly level_asset_source: string;
  readonly blot_source: string;
  readonly traversal: AdventureTraversalContract;
}

export function compile_adventure_project(
  source: string,
): CompiledAdventureProject {
  const document = parse_adventure_document(source);
  const traversal = compile_adventure_traversal(document);
  return Object.freeze({
    canonical_source: serialize_adventure_document(document),
    level_asset_source: compile_level_asset(document),
    blot_source: compile_blot_project(document, traversal),
    traversal,
  });
}

export function adventure_brush_values(
  brush: AdventureBrush,
): readonly number[] {
  return Object.freeze([
    brush_kinds.indexOf(brush.kind),
    brush.center_x2,
    brush.elevation,
    brush.center_z2,
    brush.width,
    brush.height,
    brush.depth,
    brush.yaw_quarters,
    material_slots[brush.material],
  ]);
}

function compile_level_asset(document: AdventureDocument): string {
  const fields = Array.from(
    { length: adventure_brush_field_count },
    (_, field) =>
      Array<number>(maximum_adventure_brushes).fill(field === 0 ? -1 : 0),
  );
  const brush_ids = Array<string>(maximum_adventure_brushes).fill("");
  for (const brush of document.layout.brushes) {
    brush_ids[brush.slot] = brush.id;
    for (const [field, value] of adventure_brush_values(brush).entries()) {
      fields[field][brush.slot] = value;
    }
  }
  return `${
    JSON.stringify(
      {
        format: "blot-integer-data",
        version: 1,
        name: document.layout.name,
        brush_ids,
        fields: [
          ...fields,
          [document.layout.player_start.x2, document.layout.player_start.z2],
        ],
      },
      null,
      2,
    )
  }\n`;
}

function compile_blot_project(
  document: AdventureDocument,
  traversal: AdventureTraversalContract,
): string {
  const key = bound_brush(document, "take-key");
  const gate = bound_brush(document, "unlock-exit");
  const take_key = interaction(document, "take-key");
  const unlock_gate = interaction(document, "unlock-exit");
  return `open import "blot:prelude"

const AdventureProject = {
  .runtime_token = Int;
  .project_title = Text;
  .level_name = Text;
  .take_key_label = Text;
  .unlock_gate_label = Text;
  .key_x = Int;
  .key_z = Int;
  .gate_slot = Int;
  .gate_z = Int;
  .closed_gate_blocks_route = Int;
  .closed_gate_stop_x = Int;
  .closed_gate_stop_z = Int;
  .open_gate_route_available = Int;
  .route_goal_x = Int;
  .route_goal_z = Int;
  .route_navigation_revision = Int;
  .route_path_points = Int;
  .route_path_cost = Int;
}

const project :: Int -> AdventureProject
const project = fn runtime_token => {
  .runtime_token = runtime_token;
  .project_title = ${blot_text_literal(document.project.title)};
  .level_name = ${blot_text_literal(document.layout.name)};
  .take_key_label = ${blot_text_literal(`${take_key.verb} ${take_key.target}`)};
  .unlock_gate_label = ${
    blot_text_literal(`${unlock_gate.verb} ${unlock_gate.target}`)
  };
  .key_x = ${key.center_x2 * 500_000};
  .key_z = ${key.center_z2 * 500_000};
  .gate_slot = ${gate.slot};
  .gate_z = ${gate.center_z2 * 500_000};
  .closed_gate_blocks_route = 1;
  .closed_gate_stop_x = ${traversal.closed_gate.stop_x_microunits};
  .closed_gate_stop_z = ${traversal.closed_gate.stop_z_microunits};
  .open_gate_route_available = 1;
  .route_goal_x = ${traversal.open_gate.goal_x_microunits};
  .route_goal_z = ${traversal.open_gate.goal_z_microunits};
  .route_navigation_revision = ${traversal.open_gate.navigation_revision};
  .route_path_points = ${traversal.open_gate.path_points};
  .route_path_cost = ${traversal.open_gate.path_cost_microunits};
}

return { .project = project; }
`;
}

function interaction(document: AdventureDocument, id: string) {
  const interaction = document.project.interactions.find((candidate) =>
    candidate.id === id
  );
  if (interaction === undefined) {
    throw new Error(`adventure project is missing interaction ${id}`);
  }
  return interaction;
}

function bound_brush(
  document: AdventureDocument,
  interaction_id: string,
): AdventureBrush {
  const binding = document.layout.interaction_bindings.find(({ interaction }) =>
    interaction === interaction_id
  );
  if (binding === undefined) {
    throw new Error(
      `adventure project interaction ${interaction_id} has no brush binding`,
    );
  }
  const brush = document.layout.brushes.find(({ id }) => id === binding.brush);
  if (brush === undefined) {
    throw new Error(
      `adventure project interaction ${interaction_id} binds missing brush ${binding.brush}`,
    );
  }
  return brush;
}

function blot_text_literal(value: string): string {
  return JSON.stringify(value)
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
