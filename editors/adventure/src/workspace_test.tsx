import { renderToStaticMarkup } from "react-dom/server";
import { assertStringIncludes } from "@std/assert";
import { parse_adventure_document } from "./document.ts";
import { AdventureWorkspace } from "./workspace.tsx";

const document = parse_adventure_document(JSON.stringify({
  format: "ink-adventure-project",
  version: 1,
  project: {
    title: "Gatehouse",
    preset: "third-person-action-adventure",
    starting_room: "foyer",
    rooms: [{ id: "foyer", name: "Foyer", exits: [] }],
    inventory_items: ["brass-key"],
    interactions: [{
      id: "unlock-gate",
      room: "foyer",
      verb: "Unlock",
      target: "oak gate",
      requires: "brass-key",
    }],
    checkpoints: ["foyer"],
    cinematics: [],
  },
  layout: {
    format: "ink-adventure-layout",
    version: 1,
    name: "Oak Gate",
    brushes: [{
      slot: 0,
      id: "oak-gate",
      kind: "door",
      center_x2: 0,
      elevation: 0,
      center_z2: 1,
      width: 2,
      height: 3,
      depth: 1,
      yaw_quarters: 0,
      material: "dungeon.gate.oak",
    }],
    player_start: { x2: 0, z2: 0 },
    interaction_bindings: [{
      interaction: "unlock-gate",
      brush: "oak-gate",
    }],
  },
}));

Deno.test("adventure workspace presents rooms brushes and interaction bindings", () => {
  const markup = renderToStaticMarkup(
    <AdventureWorkspace
      document={document}
      selected_brush_slot={0}
      onSelectBrush={() => {}}
    />,
  );
  assertStringIncludes(markup, "Gatehouse workspace");
  assertStringIncludes(markup, "1 rooms · 1 interactions");
  assertStringIncludes(markup, "oak-gate · unlock-gate");
  assertStringIncludes(markup, 'aria-selected="true"');
});
