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
}

export function compile_adventure_project(
  source: string,
): CompiledAdventureProject {
  const document = parse_adventure_document(source);
  return Object.freeze({
    canonical_source: serialize_adventure_document(document),
    level_asset_source: compile_level_asset(document),
    blot_source: compile_blot_project(document),
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

function compile_blot_project(document: AdventureDocument): string {
  const key = bound_brush(document, "take-key");
  const gate = bound_brush(document, "unlock-exit");
  const take_key = interaction(document, "take-key");
  const unlock_gate = interaction(document, "unlock-exit");
  return `return {
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
}
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
