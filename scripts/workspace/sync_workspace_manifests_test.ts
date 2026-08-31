import { assertEquals, assertThrows } from "@std/assert";
import {
  ink_project_kind,
  is_production_export,
} from "./sync_workspace_manifests.ts";

Deno.test("workspace paths determine their project kind", () => {
  assertEquals(ink_project_kind("packages/runtime"), "core");
  assertEquals(ink_project_kind("packages/blot"), "adapter");
  assertEquals(ink_project_kind("packages/vite"), "adapter");
  assertEquals(ink_project_kind("editors/adventure"), "editor");
  assertEquals(ink_project_kind("apps/adventure-dev"), "application");
  assertThrows(() => ink_project_kind("examples/demo"));
});

Deno.test("only production modules become package exports", () => {
  assertEquals(is_production_export("identity.ts"), true);
  assertEquals(is_production_export("workspace.tsx"), true);
  assertEquals(is_production_export("identity_test.ts"), false);
  assertEquals(is_production_export("identity_bench.ts"), false);
  assertEquals(is_production_export("legacy.ts"), false);
  assertEquals(is_production_export("migration.ts"), false);
  assertEquals(is_production_export("test_fixtures.ts"), false);
});
