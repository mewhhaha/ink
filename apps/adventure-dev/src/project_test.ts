import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  parse_adventure_document,
  serialize_adventure_document,
} from "@ink/adventure-editor/document.ts";
import { apply_adventure_layout_command } from "@ink/adventure-editor/layout.ts";
import { compile_adventure_project } from "./project.ts";

Deno.test("adventure compilation emits canonical layout and numeric Blot data", async () => {
  const source = await Deno.readTextFile(
    new URL("../projects/starter.json", import.meta.url),
  );
  const compiled = compile_adventure_project(source);
  const level = JSON.parse(compiled.level_asset_source);
  assertEquals(level.fields[0][6], 1);
  assertEquals(level.fields[8][6], 2);
  assertEquals(level.fields[9], [0, 4]);
  assertStringIncludes(compiled.blot_source, ".gate_slot = 6;");
  assertStringIncludes(compiled.blot_source, ".closed_gate_stop_z = 3490000;");
  assertStringIncludes(compiled.blot_source, ".route_goal_z = 4750000;");
  assertStringIncludes(
    compiled.blot_source,
    'open import "blot:prelude"',
  );
  assertStringIncludes(compiled.blot_source, "const AdventureProject = {");
  assertStringIncludes(
    compiled.blot_source,
    "const project :: Int -> AdventureProject",
  );
  assertEquals(compiled.traversal, {
    closed_gate: {
      type: "blocked",
      navigation_result: "unavailable",
      stop_x_microunits: 0,
      stop_z_microunits: 3_490_000,
      physics_contacts: 1,
    },
    open_gate: {
      type: "route",
      goal_x_microunits: 0,
      goal_z_microunits: 4_750_000,
      navigation_revision: 1,
      path_points: 7,
      path_cost_microunits: 3_000_000,
    },
  });
  assertEquals(
    JSON.parse(compiled.canonical_source).format,
    "ink-adventure-project",
  );
});

Deno.test("adventure text is escaped before entering generated Blot source", async () => {
  const starter = JSON.parse(
    await Deno.readTextFile(
      new URL("../projects/starter.json", import.meta.url),
    ),
  );
  starter.project.title = 'Dungeon "North"\nWing';
  const compiled = compile_adventure_project(JSON.stringify(starter));
  assertStringIncludes(
    compiled.blot_source,
    '.project_title = "Dungeon \\"North\\"\\nWing";',
  );
});

Deno.test("rebinding the exit interaction selects the placed oak gate contract", async () => {
  const starter = parse_adventure_document(
    await Deno.readTextFile(
      new URL("../projects/starter.json", import.meta.url),
    ),
  );
  const wall_bound_layout = apply_adventure_layout_command(starter.layout, {
    type: "bind_interaction",
    binding: {
      interaction: "unlock-exit",
      brush: "south-wall-west",
    },
  });
  const wall_bound = compile_adventure_project(
    serialize_adventure_document({ ...starter, layout: wall_bound_layout }),
  );
  assertStringIncludes(wall_bound.blot_source, ".gate_slot = 4;");
  assertEquals(wall_bound.traversal.open_gate.goal_x_microunits, -4_000_000);

  const gate_bound_layout = apply_adventure_layout_command(
    wall_bound_layout,
    {
      type: "bind_interaction",
      binding: {
        interaction: "unlock-exit",
        brush: "oak-gate",
      },
    },
  );
  const gate_bound = compile_adventure_project(
    serialize_adventure_document({ ...starter, layout: gate_bound_layout }),
  );
  assertStringIncludes(gate_bound.blot_source, ".gate_slot = 6;");
  assertEquals(gate_bound.traversal.closed_gate.stop_x_microunits, 0);
  assertEquals(gate_bound.traversal.closed_gate.stop_z_microunits, 3_490_000);
  assertEquals(gate_bound.traversal.open_gate.goal_x_microunits, 0);
  assertEquals(gate_bound.traversal.open_gate.goal_z_microunits, 4_750_000);
});
