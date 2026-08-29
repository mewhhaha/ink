import type { AuthoringDiagnostic } from "@ink/authoring/diagnostics.ts";
import { authoring_diagnostic } from "@ink/authoring/diagnostics.ts";
import {
  adventure_editor,
  type AdventureInteraction,
  type AdventureProject,
  type AdventureRoom,
  validate_adventure_project,
} from "./editor.ts";
import {
  type AdventureLayout,
  parse_adventure_layout,
  serialize_adventure_layout,
  validate_adventure_layout,
} from "./layout.ts";

export interface AdventureDocument {
  readonly format: "ink-adventure-project";
  readonly version: 1;
  readonly project: AdventureProject;
  readonly layout: AdventureLayout;
}

export function parse_adventure_document(source: string): AdventureDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    throw new Error("adventure project is not valid JSON", { cause });
  }
  const document = record(parsed, "adventure project");
  expect_fields(
    document,
    ["format", "layout", "project", "version"],
    "adventure project",
  );
  if (document.format !== "ink-adventure-project" || document.version !== 1) {
    throw new Error(
      `adventure project identity ${JSON.stringify(document.format)} version ${
        JSON.stringify(document.version)
      } is unsupported`,
    );
  }
  const project = parse_project(document.project);
  const layout = parse_adventure_layout(JSON.stringify(document.layout));
  const result = Object.freeze({
    format: "ink-adventure-project" as const,
    version: 1 as const,
    project,
    layout,
  });
  const errors = validate_adventure_document(result).filter(({ severity }) =>
    severity === "error"
  );
  if (errors.length > 0) {
    throw new Error(
      `adventure project is invalid: ${
        errors.map(({ message }) => message).join("; ")
      }`,
    );
  }
  return result;
}

export function serialize_adventure_document(
  document: AdventureDocument,
): string {
  const parsed_layout: unknown = JSON.parse(
    serialize_adventure_layout(document.layout),
  );
  const canonical = {
    format: "ink-adventure-project",
    version: 1,
    project: {
      title: document.project.title.trim(),
      preset: document.project.preset,
      starting_room: document.project.starting_room,
      rooms: [...document.project.rooms],
      inventory_items: [...document.project.inventory_items],
      interactions: [...document.project.interactions],
      checkpoints: [...document.project.checkpoints],
      cinematics: [...document.project.cinematics],
    },
    layout: parsed_layout,
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

export function validate_adventure_document(
  document: AdventureDocument,
): readonly AuthoringDiagnostic[] {
  const diagnostics = [
    ...validate_adventure_project(document.project),
    ...validate_adventure_layout(document.layout),
  ];
  const interactions = new Set(
    document.project.interactions.map(({ id }) => id),
  );
  for (const binding of document.layout.interaction_bindings) {
    if (interactions.has(binding.interaction)) continue;
    diagnostics.push(authoring_diagnostic({
      code: "MISSING_BOUND_INTERACTION",
      severity: "error",
      message:
        `Layout binding ${binding.interaction} has no project interaction.`,
      subject: binding.interaction,
    }));
  }
  return Object.freeze(diagnostics);
}

function parse_project(value: unknown): AdventureProject {
  const project = record(value, "adventure project model");
  expect_fields(project, [
    "checkpoints",
    "cinematics",
    "interactions",
    "inventory_items",
    "preset",
    "rooms",
    "starting_room",
    "title",
  ], "adventure project model");
  const preset = adventure_editor.presets.find(({ id }) =>
    id === project.preset
  );
  if (preset === undefined) {
    throw new Error(
      `adventure project preset ${
        JSON.stringify(project.preset)
      } is unavailable`,
    );
  }
  if (!Array.isArray(project.rooms)) {
    throw new Error("adventure project rooms must be an array");
  }
  if (!Array.isArray(project.interactions)) {
    throw new Error("adventure project interactions must be an array");
  }
  return Object.freeze({
    title: text(project.title, "adventure project title"),
    preset: preset.id,
    starting_room: identity(
      project.starting_room,
      "adventure project starting_room",
    ),
    rooms: Object.freeze(project.rooms.map(parse_room)),
    inventory_items: Object.freeze(
      identities(project.inventory_items, "adventure inventory_items"),
    ),
    interactions: Object.freeze(project.interactions.map(parse_interaction)),
    checkpoints: Object.freeze(
      identities(project.checkpoints, "adventure checkpoints"),
    ),
    cinematics: Object.freeze(
      identities(project.cinematics, "adventure cinematics"),
    ),
  });
}

function parse_room(value: unknown, index: number): AdventureRoom {
  const room = record(value, `adventure room ${index}`);
  expect_fields(room, ["exits", "id", "name"], `adventure room ${index}`);
  return Object.freeze({
    id: identity(room.id, `adventure room ${index} id`),
    name: text(room.name, `adventure room ${index} name`),
    exits: Object.freeze(
      identities(room.exits, `adventure room ${index} exits`),
    ),
  });
}

function parse_interaction(
  value: unknown,
  index: number,
): AdventureInteraction {
  const interaction = record(value, `adventure interaction ${index}`);
  const allowed = new Set([
    "grants",
    "id",
    "opens_room",
    "requires",
    "room",
    "target",
    "verb",
  ]);
  const unexpected = Object.keys(interaction).filter((field) =>
    !allowed.has(field)
  );
  if (unexpected.length > 0) {
    throw new Error(
      `adventure interaction ${index} has unsupported fields ${
        JSON.stringify(unexpected.sort())
      }`,
    );
  }
  for (const required of ["id", "room", "target", "verb"]) {
    if (required in interaction) continue;
    throw new Error(
      `adventure interaction ${index} is missing ${JSON.stringify(required)}`,
    );
  }
  return Object.freeze({
    id: identity(interaction.id, `adventure interaction ${index} id`),
    room: identity(interaction.room, `adventure interaction ${index} room`),
    verb: text(interaction.verb, `adventure interaction ${index} verb`),
    target: text(interaction.target, `adventure interaction ${index} target`),
    ...optional_identity(interaction, "requires", index),
    ...optional_identity(interaction, "grants", index),
    ...optional_identity(interaction, "opens_room", index),
  });
}

function optional_identity(
  interaction: Record<string, unknown>,
  field: "requires" | "grants" | "opens_room",
  index: number,
): Partial<Record<typeof field, string>> {
  const value = interaction[field];
  if (value === undefined) return {};
  return {
    [field]: identity(value, `adventure interaction ${index} ${field}`),
  };
}

function identities(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => identity(entry, `${label}[${index}]`));
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

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 200) {
    throw new Error(`${label} must contain 1..200 characters`);
  }
  return value.trim();
}
