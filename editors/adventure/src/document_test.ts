import { assertEquals, assertThrows } from "@std/assert";
import { create_adventure_starter } from "./editor.ts";
import {
  type AdventureDocument,
  parse_adventure_document,
  serialize_adventure_document,
  validate_adventure_document,
} from "./document.ts";

const document: AdventureDocument = {
  format: "ink-adventure-project",
  version: 1,
  project: create_adventure_starter("third-person-action-adventure"),
  layout: {
    format: "ink-adventure-layout",
    version: 1,
    name: "Gate workshop",
    brushes: [{
      slot: 0,
      id: "oak-gate",
      kind: "door",
      center_x2: 0,
      center_z2: 4,
      elevation: 0,
      width: 2,
      height: 3,
      depth: 1,
      yaw_quarters: 0,
      material: "dungeon.gate.oak",
    }],
    player_start: { x2: 0, z2: 0 },
    interaction_bindings: [{
      interaction: "unlock-exit",
      brush: "oak-gate",
    }],
  },
};

Deno.test("adventure project documents round trip canonically", () => {
  assertEquals(
    parse_adventure_document(serialize_adventure_document(document)),
    document,
  );
});

Deno.test("document diagnostics join project and spatial references", () => {
  assertEquals(
    validate_adventure_document({
      ...document,
      layout: {
        ...document.layout,
        interaction_bindings: [{ interaction: "missing", brush: "oak-gate" }],
      },
    }).map(({ code }) => code),
    ["MISSING_BOUND_INTERACTION"],
  );
});

Deno.test("project parsing rejects unknown boundary fields", () => {
  const source = JSON.parse(serialize_adventure_document(document));
  source.project.legacy = true;
  assertThrows(
    () => parse_adventure_document(JSON.stringify(source)),
    Error,
    "adventure project model fields",
  );
});
