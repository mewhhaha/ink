import { assertEquals } from "@std/assert";
import {
  commit_platformer_revision,
  create_platformer_history,
  redo_platformer_revision,
  undo_platformer_revision,
} from "./history.ts";
import { create_platformer_starter } from "./starter.ts";

Deno.test("platformer history preserves typed projects and clears a redone branch", () => {
  const classic = create_platformer_starter("classic-adventure");
  const precision = create_platformer_starter("precision");
  const momentum = create_platformer_starter("momentum");
  const committed = commit_platformer_revision(
    create_platformer_history(classic),
    "Choose precision preset",
    precision,
  );
  const undone = undo_platformer_revision(committed);
  assertEquals(undone.type, "changed");
  if (undone.type !== "changed") return;
  assertEquals(undone.history.current.document.preset_id, "classic-adventure");
  assertEquals(redo_platformer_revision(undone.history).type, "changed");

  const branched = commit_platformer_revision(
    undone.history,
    "Choose momentum preset",
    momentum,
  );
  assertEquals(branched.current.document.preset_id, "momentum");
  assertEquals(redo_platformer_revision(branched).type, "unavailable");
});
