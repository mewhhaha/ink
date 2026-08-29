import { assertStringIncludes } from "@std/assert";
import { renderToString } from "react-dom/server";
import { create_narrative_starter_project } from "./presets.ts";
import { NarrativeWorkspace } from "./workspace.tsx";

Deno.test("narrative workspace presents the authoritative beat edit", () => {
  const source = renderToString(
    <NarrativeWorkspace
      project={create_narrative_starter_project()}
      selected_scene_id="station"
      onAddBeat={() => {}}
      onSelectScene={() => {}}
    />,
  );
  assertStringIncludes(source, "The Last Station");
  assertStringIncludes(source, "The Last Station · 1 beats");
  assertStringIncludes(
    source,
    "The last train waits beneath a sky full of signals.",
  );
  assertStringIncludes(source, "Add signal warning");
});
