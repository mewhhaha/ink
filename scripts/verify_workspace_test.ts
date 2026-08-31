import { assertEquals, assertStringIncludes } from "@std/assert";
import { repository_state_difference } from "./verify_workspace.ts";

Deno.test("verification accepts an unchanged dirty repository", () => {
  const state = {
    status: " M package.json\n?? artifacts/example.png",
    fingerprint: "same-content",
  };
  assertEquals(repository_state_difference(state, state), undefined);
});

Deno.test("verification detects changed contents behind the same dirty paths", () => {
  const difference = repository_state_difference(
    { status: " M package.json", fingerprint: "before-content" },
    { status: " M package.json", fingerprint: "after-content" },
  );
  assertStringIncludes(difference ?? "", "before status:\n M package.json");
  assertStringIncludes(difference ?? "", "after status:\n M package.json");
  assertStringIncludes(difference ?? "", "before-content");
  assertStringIncludes(difference ?? "", "after-content");
});
