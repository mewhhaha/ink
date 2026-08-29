import { assertEquals, assertThrows } from "@std/assert";
import {
  add_adventure_interaction,
  adventure_editor,
  create_adventure_starter,
  validate_adventure_project,
} from "./editor.ts";

Deno.test("adventure editor exposes three workflow-specific presets", () => {
  assertEquals(adventure_editor.presets.map(({ id }) => id), [
    "point-and-click",
    "survival-horror",
    "third-person-action-adventure",
  ]);
});

Deno.test("adventure starters encode an editable inventory lock", () => {
  const project = create_adventure_starter("point-and-click");
  assertEquals(validate_adventure_project(project), []);
  assertEquals(project.interactions[1].requires, "brass-key");
});

Deno.test("adventure interactions attach only to existing rooms", () => {
  assertThrows(
    () =>
      add_adventure_interaction(create_adventure_starter("survival-horror"), {
        id: "ghost",
        room: "missing",
        verb: "Inspect",
        target: "wall",
      }),
    Error,
    "missing room missing",
  );
});

Deno.test("adventure diagnostics cover graph inventory and checkpoint references", () => {
  const project = create_adventure_starter("third-person-action-adventure");
  assertEquals(
    validate_adventure_project({
      ...project,
      rooms: [{ ...project.rooms[0], exits: ["missing"] }],
      interactions: [{
        ...project.interactions[0],
        requires: "missing-item",
      }],
      checkpoints: ["missing-checkpoint"],
    }).map(({ code }) => code),
    [
      "MISSING_ROOM_EXIT",
      "MISSING_REQUIRED_ITEM",
      "MISSING_CHECKPOINT_ROOM",
    ],
  );
});
