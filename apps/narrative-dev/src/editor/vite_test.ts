import { apply_narrative_command } from "@ink/narrative-editor/commands.ts";
import {
  narrative_beat_id,
  narrative_scene_id,
} from "@ink/narrative-editor/identity.ts";
import {
  parse_narrative_project,
  serialize_narrative_project,
} from "@ink/narrative-editor/serialization.ts";
import { assertEquals } from "@std/assert";
import { write_narrative_project } from "./vite.ts";

Deno.test("the narrative editor saves canonical projects atomically", async () => {
  const temporary_directory = await Deno.makeTempDir();
  const project_file = new URL(`file://${temporary_directory}/story.json`);
  try {
    const starter_source = await Deno.readTextFile(
      new URL("../../projects/starter.json", import.meta.url),
    );
    const edited = apply_narrative_command(
      parse_narrative_project(starter_source),
      {
        type: "add_beat",
        scene_id: narrative_scene_id("station"),
        beat: {
          id: narrative_beat_id("saved-announcement"),
          speaker: "Station",
          text: "This line was saved atomically.",
        },
      },
    );
    await write_narrative_project(
      project_file,
      serialize_narrative_project(edited),
    );
    assertEquals(
      await Deno.readTextFile(project_file),
      serialize_narrative_project(edited),
    );
  } finally {
    await Deno.remove(temporary_directory, { recursive: true });
  }
});
