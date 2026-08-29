import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { renderToString } from "react-dom/server";
import { roleplaying_editor } from "./catalog.ts";
import { apply_roleplaying_command } from "./commands.ts";
import { roleplaying_loot_id } from "./identity.ts";
import { create_roleplaying_starter_project } from "./presets.ts";
import {
  parse_roleplaying_project,
  serialize_roleplaying_project,
} from "./serialization.ts";
import { validate_roleplaying_project } from "./validation.ts";
import { RoleplayingWorkspace } from "./workspace.tsx";

Deno.test("role-playing catalog exposes focused tools and presets", () => {
  assertEquals(roleplaying_editor.tools.length, 7);
  assertEquals(roleplaying_editor.presets.length, 5);
});

Deno.test("adding ruins loot preserves and freezes the source project", () => {
  const source = create_roleplaying_starter_project();
  const changed = apply_roleplaying_command(source, {
    type: "add_loot_entry",
    loot_id: roleplaying_loot_id("ruins-cache"),
    entry: "moonstone-relic",
  });
  assertEquals(source.loot[0].entries, ["healing-herb"]);
  assertEquals(changed.loot[0].entries, ["healing-herb", "moonstone-relic"]);
  assertEquals(Object.isFrozen(changed.loot[0].entries), true);
  assertEquals(validate_roleplaying_project(changed), []);
  assertThrows(
    () =>
      apply_roleplaying_command(changed, {
        type: "add_loot_entry",
        loot_id: roleplaying_loot_id("ruins-cache"),
        entry: "moonstone-relic",
      }),
    Error,
    "repeats entry moonstone-relic",
  );
});

Deno.test("role-playing serialization round trips and rejects unknown fields", () => {
  const source = serialize_roleplaying_project(
    create_roleplaying_starter_project(),
  );
  assertEquals(
    serialize_roleplaying_project(parse_roleplaying_project(source)),
    source,
  );
  const unknown = JSON.parse(source);
  unknown.revision = 1;
  assertThrows(
    () => parse_roleplaying_project(JSON.stringify(unknown)),
    Error,
    "unknown [revision]",
  );
});

Deno.test("role-playing workspace presents the authoritative loot edit", () => {
  const source = renderToString(
    <RoleplayingWorkspace
      project={create_roleplaying_starter_project()}
      selected_region_id="ruins"
      onAddLoot={() => {}}
      onSelectRegion={() => {}}
    />,
  );
  assertStringIncludes(source, "Old Ruins");
  assertStringIncludes(source, "healing-herb");
  assertStringIncludes(source, "Add moonstone relic");
});
