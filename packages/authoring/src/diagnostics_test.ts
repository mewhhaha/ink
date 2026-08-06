import { assertEquals, assertThrows } from "@std/assert";
import { authoring_diagnostic, has_authoring_errors } from "./diagnostics.ts";

Deno.test("authoring diagnostics retain actionable evidence", () => {
  const diagnostic = authoring_diagnostic({
    code: "MISSING_SPAWN",
    severity: "error",
    message: "Level intro has no player spawn.",
    subject: "level:intro",
    recovery: "Place one spawn with the Spawn tool.",
  });
  assertEquals(has_authoring_errors([diagnostic]), true);
  assertEquals(diagnostic.recovery, "Place one spawn with the Spawn tool.");
});

Deno.test("authoring diagnostic codes reject ambiguous vocabulary", () => {
  assertThrows(
    () =>
      authoring_diagnostic({
        code: "missing spawn",
        severity: "warning",
        message: "Missing spawn.",
      }),
    Error,
    "uppercase snake case",
  );
});
