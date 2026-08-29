import { assertEquals, assertNotStrictEquals, assertThrows } from "@std/assert";
import { apply_narrative_command } from "./commands.ts";
import { narrative_beat_id, narrative_scene_id } from "./identity.ts";
import { create_narrative_starter_project } from "./presets.ts";

Deno.test("adding a beat returns a frozen project without changing the source", () => {
  const source = create_narrative_starter_project();
  const changed = apply_narrative_command(source, {
    type: "add_beat",
    scene_id: narrative_scene_id("station"),
    beat: {
      id: narrative_beat_id("announcement"),
      speaker: "Station",
      text: "The last service now boards from platform three.",
    },
  });

  assertEquals(source.scenes[0].beats.length, 1);
  assertEquals(changed.scenes[0].beats.length, 2);
  assertNotStrictEquals(changed, source);
  assertEquals(Object.isFrozen(changed.scenes[0].beats), true);
});

Deno.test("narrative commands reject duplicate and missing identities with evidence", () => {
  const source = create_narrative_starter_project();
  assertThrows(
    () =>
      apply_narrative_command(source, {
        type: "add_beat",
        scene_id: narrative_scene_id("station"),
        beat: source.scenes[0].beats[0],
      }),
    Error,
    "beat repeats identity arrival",
  );
  assertThrows(
    () =>
      apply_narrative_command(source, {
        type: "remove_scene",
        scene_id: narrative_scene_id("missing"),
      }),
    Error,
    "has no scene missing",
  );
});
