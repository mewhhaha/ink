import { assertEquals, assertThrows } from "@std/assert";
import {
  commit_authoring_revision,
  create_authoring_history,
  redo_authoring_revision,
  undo_authoring_revision,
} from "./history.ts";

Deno.test("authoring history commits, undoes, and redoes immutable documents", () => {
  const initial = create_authoring_history({ platforms: 1 });
  const changed = commit_authoring_revision(
    initial,
    "Place platform",
    { platforms: 2 },
  );
  assertEquals(changed.current.sequence, 1);
  assertEquals(changed.current.document, { platforms: 2 });
  const undone = undo_authoring_revision(changed);
  assertEquals(undone.type, "changed");
  if (undone.type !== "changed") return;
  assertEquals(undone.history.current.document, { platforms: 1 });
  const redone = redo_authoring_revision(undone.history);
  assertEquals(redone.type, "changed");
  if (redone.type === "changed") {
    assertEquals(redone.history.current.document, { platforms: 2 });
  }
});

Deno.test("new authoring commits clear redo history and retain the configured limit", () => {
  let history = create_authoring_history(0);
  history = commit_authoring_revision(history, "One", 1, 2);
  history = commit_authoring_revision(history, "Two", 2, 2);
  history = commit_authoring_revision(history, "Three", 3, 2);
  assertEquals(history.previous.map(({ document }) => document), [1, 2]);
  const undone = undo_authoring_revision(history);
  if (undone.type !== "changed") {
    throw new Error("undo unexpectedly unavailable");
  }
  const branched = commit_authoring_revision(undone.history, "Branch", 9, 2);
  assertEquals(branched.next, []);
  assertEquals(redo_authoring_revision(branched).type, "unavailable");
});

Deno.test("authoring history rejects empty labels and invalid limits", () => {
  const history = create_authoring_history({});
  assertThrows(
    () => commit_authoring_revision(history, " ", {}),
    Error,
    "label cannot be empty",
  );
  assertThrows(
    () => commit_authoring_revision(history, "Change", {}, 0),
    Error,
    "must be a positive safe integer",
  );
});
