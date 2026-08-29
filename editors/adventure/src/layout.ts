import {
  authoring_diagnostic,
  type AuthoringDiagnostic,
} from "@ink/authoring/diagnostics.ts";

export const maximum_adventure_brushes = 48;

export const adventure_material_keys = [
  "dungeon.floor.flagstone",
  "dungeon.wall.limestone",
  "dungeon.gate.oak",
] as const;

export type AdventureMaterialKey = typeof adventure_material_keys[number];
export type AdventureBrushKind = "block" | "door" | "stairs";

export interface AdventureBrush {
  readonly slot: number;
  readonly id: string;
  readonly kind: AdventureBrushKind;
  readonly center_x2: number;
  readonly elevation: number;
  readonly center_z2: number;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly yaw_quarters: number;
  readonly material: AdventureMaterialKey;
}

export interface AdventureInteractionBinding {
  readonly interaction: string;
  readonly brush: string;
}

export interface AdventureLayout {
  readonly format: "ink-adventure-layout";
  readonly version: 1;
  readonly name: string;
  readonly brushes: readonly AdventureBrush[];
  readonly player_start: { readonly x2: number; readonly z2: number };
  readonly interaction_bindings: readonly AdventureInteractionBinding[];
}

export type AdventureLayoutCommand =
  | {
    readonly type: "add_brush";
    readonly brush: Omit<AdventureBrush, "slot">;
  }
  | { readonly type: "replace_brush"; readonly brush: AdventureBrush }
  | { readonly type: "remove_brush"; readonly slot: number }
  | {
    readonly type: "move_player_start";
    readonly position: { readonly x2: number; readonly z2: number };
  }
  | {
    readonly type: "bind_interaction";
    readonly binding: AdventureInteractionBinding;
  };

const brush_kinds = ["block", "door", "stairs"] as const;

export function parse_adventure_layout(source: string): AdventureLayout {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    throw new Error("adventure layout is not valid JSON", { cause });
  }
  const document = record(parsed, "adventure layout");
  expect_fields(document, [
    "brushes",
    "format",
    "interaction_bindings",
    "name",
    "player_start",
    "version",
  ], "adventure layout");
  if (document.format !== "ink-adventure-layout" || document.version !== 1) {
    throw new Error(
      `adventure layout identity ${JSON.stringify(document.format)} version ${
        JSON.stringify(document.version)
      } is unsupported`,
    );
  }
  const name = nonempty_text(document.name, "adventure layout name");
  if (!Array.isArray(document.brushes)) {
    throw new Error("adventure layout brushes must be an array");
  }
  if (document.brushes.length > maximum_adventure_brushes) {
    throw new Error(
      `adventure layout has ${document.brushes.length} brushes; maximum is ${maximum_adventure_brushes}`,
    );
  }
  const brushes = document.brushes.map(parse_brush);
  const player_start = parse_grid_point(
    document.player_start,
    "adventure player start",
  );
  if (!Array.isArray(document.interaction_bindings)) {
    throw new Error("adventure interaction_bindings must be an array");
  }
  const interaction_bindings = document.interaction_bindings.map(
    parse_interaction_binding,
  );
  const layout = Object.freeze({
    format: "ink-adventure-layout" as const,
    version: 1 as const,
    name,
    brushes: Object.freeze(brushes),
    player_start: Object.freeze(player_start),
    interaction_bindings: Object.freeze(interaction_bindings),
  });
  const errors = validate_adventure_layout(layout).filter(({ severity }) =>
    severity === "error"
  );
  if (errors.length > 0) {
    throw new Error(
      `adventure layout is invalid: ${
        errors.map(({ message }) => message).join("; ")
      }`,
    );
  }
  return layout;
}

export function serialize_adventure_layout(layout: AdventureLayout): string {
  const canonical = canonical_adventure_layout(layout);
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

export function apply_adventure_layout_command(
  layout: AdventureLayout,
  command: AdventureLayoutCommand,
): AdventureLayout {
  switch (command.type) {
    case "add_brush": {
      const occupied = new Set(layout.brushes.map(({ slot }) => slot));
      const slot = Array.from(
        { length: maximum_adventure_brushes },
        (_, candidate) => candidate,
      ).find((candidate) => !occupied.has(candidate));
      if (slot === undefined) {
        throw new Error(
          `adventure layout already uses all ${maximum_adventure_brushes} brush slots`,
        );
      }
      return canonical_adventure_layout({
        ...layout,
        brushes: [...layout.brushes, { ...command.brush, slot }],
      });
    }
    case "replace_brush": {
      const index = layout.brushes.findIndex(({ slot }) =>
        slot === command.brush.slot
      );
      if (index < 0) {
        throw new Error(
          `adventure brush slot ${command.brush.slot} does not exist`,
        );
      }
      const brushes = [...layout.brushes];
      brushes[index] = command.brush;
      return canonical_adventure_layout({ ...layout, brushes });
    }
    case "remove_brush": {
      const brushes = layout.brushes.filter(({ slot }) =>
        slot !== command.slot
      );
      if (brushes.length === layout.brushes.length) return layout;
      const removed = new Set(
        layout.brushes.filter(({ slot }) => slot === command.slot).map((
          { id },
        ) => id),
      );
      return canonical_adventure_layout({
        ...layout,
        brushes,
        interaction_bindings: layout.interaction_bindings.filter(({ brush }) =>
          !removed.has(brush)
        ),
      });
    }
    case "move_player_start":
      return canonical_adventure_layout({
        ...layout,
        player_start: command.position,
      });
    case "bind_interaction": {
      const interaction_bindings = layout.interaction_bindings.filter(
        ({ interaction }) => interaction !== command.binding.interaction,
      );
      return canonical_adventure_layout({
        ...layout,
        interaction_bindings: [...interaction_bindings, command.binding],
      });
    }
  }
}

export function validate_adventure_layout(
  layout: AdventureLayout,
): readonly AuthoringDiagnostic[] {
  const diagnostics: AuthoringDiagnostic[] = [];
  const slots = new Set<number>();
  const brushes = new Set<string>();
  for (const brush of layout.brushes) {
    if (slots.has(brush.slot)) {
      diagnostics.push(authoring_diagnostic({
        code: "DUPLICATE_BRUSH_SLOT",
        severity: "error",
        message: `Brush slot ${brush.slot} is used more than once.`,
        subject: brush.id,
      }));
    }
    if (brushes.has(brush.id)) {
      diagnostics.push(authoring_diagnostic({
        code: "DUPLICATE_BRUSH_ID",
        severity: "error",
        message: `Brush identity ${brush.id} is used more than once.`,
        subject: brush.id,
      }));
    }
    slots.add(brush.slot);
    brushes.add(brush.id);
  }
  const interactions = new Set<string>();
  for (const binding of layout.interaction_bindings) {
    if (interactions.has(binding.interaction)) {
      diagnostics.push(authoring_diagnostic({
        code: "DUPLICATE_INTERACTION_BINDING",
        severity: "error",
        message:
          `Interaction ${binding.interaction} has more than one brush binding.`,
        subject: binding.interaction,
      }));
    }
    if (!brushes.has(binding.brush)) {
      diagnostics.push(authoring_diagnostic({
        code: "MISSING_BOUND_BRUSH",
        severity: "error",
        message:
          `Interaction ${binding.interaction} binds missing brush ${binding.brush}.`,
        subject: binding.interaction,
      }));
    }
    interactions.add(binding.interaction);
  }
  return Object.freeze(diagnostics);
}

function canonical_adventure_layout(layout: AdventureLayout): AdventureLayout {
  const candidate = {
    format: "ink-adventure-layout",
    version: 1,
    name: layout.name.trim(),
    brushes: [...layout.brushes].sort((left, right) => left.slot - right.slot),
    player_start: layout.player_start,
    interaction_bindings: [...layout.interaction_bindings].sort((left, right) =>
      left.interaction.localeCompare(right.interaction)
    ),
  };
  return parse_adventure_layout(JSON.stringify(candidate));
}

function parse_brush(value: unknown, index: number): AdventureBrush {
  const brush = record(value, `adventure brush ${index}`);
  expect_fields(brush, [
    "center_x2",
    "center_z2",
    "depth",
    "elevation",
    "height",
    "id",
    "kind",
    "material",
    "slot",
    "width",
    "yaw_quarters",
  ], `adventure brush ${index}`);
  const id = identity(brush.id, `adventure brush ${index} id`);
  if (!brush_kinds.includes(brush.kind as AdventureBrushKind)) {
    throw new Error(
      `adventure brush ${JSON.stringify(id)} kind ${
        JSON.stringify(brush.kind)
      } is unsupported`,
    );
  }
  if (
    !adventure_material_keys.includes(brush.material as AdventureMaterialKey)
  ) {
    throw new Error(
      `adventure brush ${JSON.stringify(id)} material ${
        JSON.stringify(brush.material)
      } is unsupported`,
    );
  }
  return Object.freeze({
    slot: integer(brush.slot, 0, maximum_adventure_brushes - 1, `${id} slot`),
    id,
    kind: brush.kind as AdventureBrushKind,
    center_x2: integer(brush.center_x2, -128, 128, `${id} center_x2`),
    elevation: integer(brush.elevation, -16, 16, `${id} elevation`),
    center_z2: integer(brush.center_z2, -128, 128, `${id} center_z2`),
    width: integer(brush.width, 1, 32, `${id} width`),
    height: integer(brush.height, 1, 16, `${id} height`),
    depth: integer(brush.depth, 1, 32, `${id} depth`),
    yaw_quarters: integer(
      brush.yaw_quarters,
      0,
      3,
      `${id} yaw_quarters`,
    ),
    material: brush.material as AdventureMaterialKey,
  });
}

function parse_interaction_binding(
  value: unknown,
  index: number,
): AdventureInteractionBinding {
  const binding = record(value, `adventure interaction binding ${index}`);
  expect_fields(
    binding,
    ["brush", "interaction"],
    `adventure interaction binding ${index}`,
  );
  return Object.freeze({
    interaction: identity(
      binding.interaction,
      `adventure interaction binding ${index} interaction`,
    ),
    brush: identity(
      binding.brush,
      `adventure interaction binding ${index} brush`,
    ),
  });
}

function parse_grid_point(
  value: unknown,
  label: string,
): { readonly x2: number; readonly z2: number } {
  const point = record(value, label);
  expect_fields(point, ["x2", "z2"], label);
  return Object.freeze({
    x2: integer(point.x2, -128, 128, `${label} x2`),
    z2: integer(point.z2, -128, 128, `${label} z2`),
  });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expect_fields(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  if (actual.join("\n") !== [...expected].sort().join("\n")) {
    throw new Error(`${label} fields are ${JSON.stringify(actual)}`);
  }
}

function identity(value: unknown, label: string): string {
  if (
    typeof value !== "string" || value.length > 80 ||
    !/^[a-z][a-z0-9-]*$/.test(value)
  ) {
    throw new Error(
      `${label} ${JSON.stringify(value)} must be a lowercase dashed identity`,
    );
  }
  return value;
}

function nonempty_text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 120) {
    throw new Error(`${label} must contain 1..120 characters`);
  }
  return value.trim();
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    !Number.isSafeInteger(value) || (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new Error(
      `${label} ${
        JSON.stringify(value)
      } must be an integer in ${minimum}..${maximum}`,
    );
  }
  return value as number;
}
