import { build_blot_game } from "@ink/blot/build.ts";
import { apply_narrative_command } from "@ink/narrative-editor/commands.ts";
import {
  narrative_beat_id,
  narrative_scene_id,
} from "@ink/narrative-editor/identity.ts";
import {
  parse_narrative_project,
  serialize_narrative_project,
} from "@ink/narrative-editor/serialization.ts";
import {
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { compile_narrative_project } from "../project.ts";
import {
  open_narrative_session,
  play_generated_narrative,
} from "./scenario.ts";

const viewport = { width: 960, height: 540 };
const application_directory = new URL("../../", import.meta.url);

Deno.test("the narrative guest exposes localized beats and both authored choices", async () => {
  const session = await open_narrative_session();
  try {
    const initial = await session.observe(viewport);
    assertEquals(initial.observation.status.done, false);
    assertEquals(initial.observation.status.label, "The Last Station");
    assertStringIncludes(
      initial.observation.status.value,
      "Mara: The last train waits beneath a sky full of signals.",
    );
    assertStringIncludes(initial.observation.status.value, "2 timeline beats");
    assertEquals(initial.observation.actions.map(({ id }) => id), [
      "follow-signal",
      "board-train",
      "restart",
    ]);
  } finally {
    await session.close();
  }
});

Deno.test("both choices reach distinct endings with evidence and replay parity", async () => {
  const [signal, ticket] = await play_generated_narrative();
  assertEquals(signal.ending, "The Answer");
  assertStringIncludes(signal.evidence, "Unfamiliar signal");
  assertEquals(signal.snapshot_checksum, signal.replay_checksum);
  assertEquals(ticket.ending, "A New Shore");
  assertStringIncludes(ticket.evidence, "Silver train ticket");
  assertEquals(ticket.snapshot_checksum, ticket.replay_checksum);
  assertNotEquals(signal.snapshot_checksum, ticket.snapshot_checksum);
});

Deno.test("adding a beat and rebuilding makes the new dialogue authoritative", async () => {
  const starter_source = await Deno.readTextFile(
    new URL("../../projects/starter.json", import.meta.url),
  );
  const edited = apply_narrative_command(
    parse_narrative_project(starter_source),
    {
      type: "add_beat",
      scene_id: narrative_scene_id("station"),
      beat: {
        id: narrative_beat_id("signal-warning"),
        speaker: "Station",
        text: "Warning: the green signal does not belong to this line.",
      },
    },
  );
  const compiled = compile_narrative_project(
    serialize_narrative_project(edited),
  );
  assertEquals(compiled.initial_beat_count, 3);
  assertEquals(compiled.timeline_event_count, 3);
  assertEquals(compiled.audio_command_count, 1);
  const temporary_directory = new URL(
    `${await Deno.makeTempDir({
      dir: application_directory.pathname,
      prefix: ".narrative-rebuild-",
    })}/`,
    "file:///",
  );
  try {
    await Deno.mkdir(new URL("src/blot/game/", temporary_directory), {
      recursive: true,
    });
    await Deno.mkdir(new URL("src/blot/generated/", temporary_directory), {
      recursive: true,
    });
    await Promise.all([
      Deno.copyFile(
        new URL("src/blot/game/main.blot", application_directory),
        new URL("src/blot/game/main.blot", temporary_directory),
      ),
      Deno.copyFile(
        new URL("src/blot/prelude.blot", application_directory),
        new URL("src/blot/prelude.blot", temporary_directory),
      ),
      Deno.writeTextFile(
        new URL("src/blot/generated/project.blot", temporary_directory),
        compiled.blot_source,
      ),
    ]);
    await build_blot_game({
      artifact_name: "edited_narrative",
      assets_directory: new URL("assets/", application_directory),
      compiler: new URL("../../../blot/src/cli.ts", application_directory),
      entrypoint: new URL("src/blot/game/main.blot", temporary_directory),
      public_directory: new URL("generated/", temporary_directory),
      working_directory: application_directory,
    });
    const session = await open_narrative_session(
      new URL("generated/", temporary_directory),
      "edited_narrative",
    );
    try {
      const presentation = await session.observe(viewport);
      assertStringIncludes(
        presentation.observation.status.value,
        "Station: Warning: the green signal does not belong to this line.",
      );
      assertStringIncludes(
        presentation.observation.status.value,
        "3 timeline beats",
      );
    } finally {
      await session.close();
    }
  } finally {
    await Deno.remove(temporary_directory, { recursive: true });
  }
});
