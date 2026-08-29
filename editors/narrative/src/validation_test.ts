import { assertEquals } from "@std/assert";
import { narrative_scene_id } from "./identity.ts";
import { create_narrative_starter_project } from "./presets.ts";
import { validate_narrative_project } from "./validation.ts";

Deno.test("the branching starter is reachable and reference complete", () => {
  assertEquals(
    validate_narrative_project(create_narrative_starter_project()),
    [],
  );
});

Deno.test("validation reports duplicate identities, empty scenes, and orphaned endings", () => {
  const source = create_narrative_starter_project();
  const diagnostics = validate_narrative_project({
    ...source,
    scenes: [
      ...source.scenes,
      {
        id: source.scenes[0].id,
        title: "Duplicate",
        beats: [],
        choices: [],
      },
    ],
    endings: [{
      ...source.endings[0],
      scene_id: narrative_scene_id("missing"),
    }],
  });
  assertEquals(diagnostics.map(({ code }) => code), [
    "DUPLICATE_SCENE",
    "EMPTY_SCENE",
    "UNKNOWN_ENDING_SCENE",
    "UNREACHABLE_SCENE",
    "UNREACHABLE_SCENE",
  ]);
});
