import { specialized_editor_descriptor } from "@ink/authoring/catalog.ts";
import {
  authoring_diagnostic,
  type AuthoringDiagnostic,
} from "@ink/authoring/diagnostics.ts";
import {
  editor_preset_id,
  editor_tool_id,
  type EditorPresetId,
  specialized_editor_id,
} from "@ink/authoring/identity.ts";

export interface AdventureRoom {
  readonly id: string;
  readonly name: string;
  readonly exits: readonly string[];
}

export interface AdventureInteraction {
  readonly id: string;
  readonly room: string;
  readonly verb: string;
  readonly target: string;
  readonly requires?: string;
  readonly grants?: string;
  readonly opens_room?: string;
}

export interface AdventureProject {
  readonly title: string;
  readonly preset: EditorPresetId;
  readonly starting_room: string;
  readonly rooms: readonly AdventureRoom[];
  readonly inventory_items: readonly string[];
  readonly interactions: readonly AdventureInteraction[];
  readonly checkpoints: readonly string[];
  readonly cinematics: readonly string[];
}

export const adventure_editor = specialized_editor_descriptor({
  id: specialized_editor_id("adventure"),
  label: "Adventure",
  summary:
    "Build spaces, interactions, inventory locks, cinematics, and checkpoints.",
  vocabulary: [
    "room",
    "interaction",
    "inventory",
    "clue",
    "cinematic",
    "checkpoint",
  ],
  tools: [
    ["place-room", "Room", "Create a navigable story space."],
    ["connect-exit", "Exit", "Connect two rooms."],
    ["add-interaction", "Interaction", "Give an object a contextual action."],
    [
      "add-inventory-lock",
      "Inventory lock",
      "Require or grant an authored item.",
    ],
    ["add-cinematic", "Cinematic", "Place a story beat on the level timeline."],
    ["place-checkpoint", "Checkpoint", "Choose a safe restart location."],
  ].map(([id, label, purpose]) => ({ id: editor_tool_id(id), label, purpose })),
  presets: [
    [
      "point-and-click",
      "Point-and-click",
      "Rooms, verbs, inventory puzzles, and conversations.",
      ["context verbs", "inventory combinations", "room navigation"],
    ],
    [
      "survival-horror",
      "Survival Horror",
      "Scarce resources, locked routes, threats, and safe rooms.",
      ["resource scarcity", "pursuit", "safe rooms"],
    ],
    [
      "third-person-action-adventure",
      "Third-person Action Adventure",
      "Traversal, combat spaces, cinematics, and checkpoints.",
      ["spatial traversal", "combat encounter", "cinematic checkpoint"],
    ],
  ].map(([id, label, summary, characteristic_mechanics]) => ({
    id: editor_preset_id(id as string),
    label: label as string,
    summary: summary as string,
    characteristic_mechanics: characteristic_mechanics as string[],
  })),
});

export function create_adventure_starter(preset: string): AdventureProject {
  const selected = adventure_editor.presets.find(({ id }) => id === preset);
  if (selected === undefined) {
    throw new Error(
      `adventure preset ${JSON.stringify(preset)} is unavailable`,
    );
  }
  return Object.freeze({
    title: `${selected.label} Starter`,
    preset: selected.id,
    starting_room: "foyer",
    rooms: Object.freeze([
      { id: "foyer", name: "Foyer", exits: ["workshop"] },
      { id: "workshop", name: "Workshop", exits: ["foyer", "exit"] },
      { id: "exit", name: "Exit", exits: ["workshop"] },
    ]),
    inventory_items: Object.freeze(["brass-key"]),
    interactions: Object.freeze([{
      id: "take-key",
      room: "foyer",
      verb: "Take",
      target: "brass key",
      grants: "brass-key",
    }, {
      id: "unlock-exit",
      room: "workshop",
      verb: "Unlock",
      target: "exit",
      requires: "brass-key",
      opens_room: "exit",
    }]),
    checkpoints: Object.freeze(["foyer"]),
    cinematics: Object.freeze(["arrival"]),
  });
}

export function add_adventure_interaction(
  project: AdventureProject,
  interaction: AdventureInteraction,
): AdventureProject {
  if (project.interactions.some(({ id }) => id === interaction.id)) {
    throw new Error(`adventure interaction repeats ${interaction.id}`);
  }
  if (!project.rooms.some(({ id }) => id === interaction.room)) {
    throw new Error(
      `adventure interaction ${interaction.id} references missing room ${interaction.room}`,
    );
  }
  return Object.freeze({
    ...project,
    interactions: Object.freeze([
      ...project.interactions,
      Object.freeze(interaction),
    ]),
  });
}

export function validate_adventure_project(
  project: AdventureProject,
): readonly AuthoringDiagnostic[] {
  const diagnostics: AuthoringDiagnostic[] = [];
  const rooms = new Set<string>();
  for (const room of project.rooms) {
    if (rooms.has(room.id)) {
      diagnostics.push(authoring_diagnostic({
        code: "DUPLICATE_ROOM",
        severity: "error",
        message: `Room identity ${room.id} is used more than once.`,
        subject: room.id,
      }));
    }
    rooms.add(room.id);
  }
  if (!rooms.has(project.starting_room)) {
    diagnostics.push(authoring_diagnostic({
      code: "MISSING_STARTING_ROOM",
      severity: "error",
      message:
        `${project.title} starts in missing room ${project.starting_room}.`,
      recovery: "Choose an existing room as the player start.",
    }));
  }
  for (const room of project.rooms) {
    for (const exit of room.exits) {
      if (rooms.has(exit)) continue;
      diagnostics.push(authoring_diagnostic({
        code: "MISSING_ROOM_EXIT",
        severity: "error",
        message: `Room ${room.id} exits to missing room ${exit}.`,
        subject: room.id,
      }));
    }
  }
  const inventory = new Set<string>();
  for (const item of project.inventory_items) {
    if (inventory.has(item)) {
      diagnostics.push(authoring_diagnostic({
        code: "DUPLICATE_INVENTORY_ITEM",
        severity: "error",
        message: `Inventory identity ${item} is used more than once.`,
        subject: item,
      }));
    }
    inventory.add(item);
  }
  const interactions = new Set<string>();
  for (const interaction of project.interactions) {
    if (interactions.has(interaction.id)) {
      diagnostics.push(authoring_diagnostic({
        code: "DUPLICATE_INTERACTION",
        severity: "error",
        message: `Interaction identity ${interaction.id} is used more than once.`,
        subject: interaction.id,
      }));
    }
    interactions.add(interaction.id);
    if (!rooms.has(interaction.room)) {
      diagnostics.push(
        authoring_diagnostic({
          code: "ORPHAN_INTERACTION",
          severity: "error",
          message:
            `Interaction ${interaction.id} references missing room ${interaction.room}.`,
          subject: interaction.id,
        }),
      );
    }
    if (
      interaction.opens_room !== undefined && !rooms.has(interaction.opens_room)
    ) {
      diagnostics.push(
        authoring_diagnostic({
          code: "MISSING_UNLOCK_DESTINATION",
          severity: "error",
          message:
            `Interaction ${interaction.id} opens missing room ${interaction.opens_room}.`,
          subject: interaction.id,
        }),
      );
    }
    if (
      interaction.requires !== undefined &&
      !inventory.has(interaction.requires)
    ) {
      diagnostics.push(authoring_diagnostic({
        code: "MISSING_REQUIRED_ITEM",
        severity: "error",
        message:
          `Interaction ${interaction.id} requires missing inventory item ${interaction.requires}.`,
        subject: interaction.id,
      }));
    }
    if (interaction.grants !== undefined && !inventory.has(interaction.grants)) {
      diagnostics.push(authoring_diagnostic({
        code: "MISSING_GRANTED_ITEM",
        severity: "error",
        message:
          `Interaction ${interaction.id} grants missing inventory item ${interaction.grants}.`,
        subject: interaction.id,
      }));
    }
  }
  for (const checkpoint of project.checkpoints) {
    if (rooms.has(checkpoint)) continue;
    diagnostics.push(authoring_diagnostic({
      code: "MISSING_CHECKPOINT_ROOM",
      severity: "error",
      message: `Checkpoint ${checkpoint} references a missing room.`,
      subject: checkpoint,
    }));
  }
  if (project.checkpoints.length === 0) {
    diagnostics.push(
      authoring_diagnostic({
        code: "MISSING_CHECKPOINT",
        severity: "warning",
        message: `${project.title} has no safe restart point.`,
        recovery: "Place a checkpoint in a safe room.",
      }),
    );
  }
  return Object.freeze(diagnostics);
}
