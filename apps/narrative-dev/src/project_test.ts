import { apply_narrative_command } from "@ink/narrative-editor/commands.ts";
import {
  narrative_beat_id,
  narrative_scene_id,
} from "@ink/narrative-editor/identity.ts";
import {
  parse_narrative_project,
  serialize_narrative_project,
} from "@ink/narrative-editor/serialization.ts";
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { compile_narrative_project } from "./project.ts";

const starter_file = new URL("../projects/starter.json", import.meta.url);

Deno.test("narrative compiler derives semantic package output and safe Blot text", async () => {
  const compiled = compile_narrative_project(
    await Deno.readTextFile(starter_file),
  );
  assertEquals(compiled.initial_beat_count, 1);
  assertEquals(compiled.timeline_event_count, 1);
  assertEquals(compiled.ui_node_count, 4);
  assertEquals(compiled.audio_command_count, 1);
  assertStringIncludes(compiled.blot_source, "Mara: The last train waits");
  assertStringIncludes(compiled.blot_source, "1 timeline beats");
});

Deno.test("adding editor dialogue changes generated Blot source and schema input", async () => {
  const initial_source = await Deno.readTextFile(starter_file);
  const initial = compile_narrative_project(initial_source);
  const edited = apply_narrative_command(
    parse_narrative_project(initial_source),
    {
      type: "add_beat",
      scene_id: narrative_scene_id("station"),
      beat: {
        id: narrative_beat_id("quoted-announcement"),
        speaker: "Station",
        text: 'The "last" service is ready.',
      },
    },
  );
  const changed = compile_narrative_project(
    serialize_narrative_project(edited),
  );
  assertEquals(changed.initial_beat_count, 2);
  assertStringIncludes(changed.blot_source, 'The \\"last\\" service is ready.');
  assertStringIncludes(changed.canonical_source, "quoted-announcement");
  assertEquals(initial.blot_source === changed.blot_source, false);
});

Deno.test("narrative compiler rejects projects outside the two-choice preset", async () => {
  const project = parse_narrative_project(
    await Deno.readTextFile(starter_file),
  );
  const source = serialize_narrative_project({
    ...project,
    scenes: project.scenes.map((scene) =>
      scene.id === project.initial_scene_id
        ? { ...scene, choices: scene.choices.slice(0, 1) }
        : scene
    ).filter(({ id }) => id !== "harbor"),
    endings: project.endings.filter(({ scene_id }) => scene_id !== "harbor"),
  });
  assertThrows(
    () => compile_narrative_project(source),
    Error,
    "must offer exactly two choices; found 1",
  );
});
