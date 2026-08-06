import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CommandPalette,
  filter_commands,
  IconButton,
  Outliner,
  TextField,
} from "./index.ts";
import { EditorTabs } from "./layout.tsx";
import { CapabilityState, ErrorState } from "./states.tsx";
import { timeline_ticks, TimelineRuler } from "./graph.tsx";

Deno.test("icon buttons expose their required label and disabled state", () => {
  const markup = renderToStaticMarkup(
    <IconButton
      label="Delete node"
      icon="×"
      interaction="disabled"
      onPress={() => {}}
    />,
  );

  assertStringIncludes(markup, 'aria-label="Delete node"');
  assertStringIncludes(markup, "disabled");
  assertStringIncludes(markup, 'type="button"');
});

Deno.test("text fields connect errors and descriptions to native inputs", () => {
  const markup = renderToStaticMarkup(
    <TextField
      id="node-name"
      label="Name"
      value="Camera"
      description="Unique in this scene"
      error="Name is already used"
      onValueChange={() => {}}
    />,
  );

  assertStringIncludes(
    markup,
    '<label class="ink-field-label" for="node-name">Name</label>',
  );
  assertStringIncludes(
    markup,
    'aria-describedby="node-name-hint node-name-error"',
  );
  assertStringIncludes(markup, 'aria-invalid="true"');
});

Deno.test("tabs render one selected tab and its associated panel", () => {
  const markup = renderToStaticMarkup(
    <EditorTabs
      label="Inspector views"
      tabs={[
        { id: "transform", label: "Transform", panel: "Transform panel" },
        { id: "material", label: "Material", panel: "Material panel" },
      ]}
      selected_id="material"
      onSelect={() => {}}
    />,
  );

  assertStringIncludes(markup, 'role="tablist"');
  assertStringIncludes(markup, 'aria-selected="true"');
  assertStringIncludes(markup, 'role="tabpanel"');
  assertStringIncludes(markup, "Material panel");
});

Deno.test("outliner branches expose tree selection and expansion semantics", () => {
  const markup = renderToStaticMarkup(
    <Outliner
      label="Scene"
      nodes={[{
        id: "world",
        label: "World",
        children: [{ id: "camera", label: "Camera" }],
      }]}
      selected_id="camera"
      expanded_ids={new Set(["world"])}
      onSelect={() => {}}
      onExpandedChange={() => {}}
    />,
  );

  assertStringIncludes(markup, 'role="tree"');
  assertStringIncludes(markup, 'aria-expanded="true"');
  assertStringIncludes(markup, 'aria-selected="true"');
  assertStringIncludes(markup, "Camera");
});

Deno.test("command filtering matches all query terms across group and label", () => {
  const commands = [
    {
      id: "scene.save",
      label: "Save scene",
      group: "File",
      shortcut: "Ctrl+S",
    },
    {
      id: "scene.frame",
      label: "Frame selection",
      group: "View",
      shortcut: "F",
    },
  ];

  assertEquals(
    filter_commands(commands, "file save").map((command) => command.id),
    ["scene.save"],
  );
  assertEquals(filter_commands(commands, "missing"), []);
  const markup = renderToStaticMarkup(
    <CommandPalette
      label="Commands"
      visibility="open"
      query="frame"
      commands={commands}
      onQueryChange={() => {}}
      onExecute={() => {}}
      onDismiss={() => {}}
    />,
  );
  assertStringIncludes(markup, "Frame selection");
  assertStringIncludes(markup, 'role="listbox"');
});

Deno.test("timeline ticks include a non-divisible duration endpoint", () => {
  assertEquals(timeline_ticks(2.5, 1), [0, 1, 2, 2.5]);
  assertThrows(
    () => timeline_ticks(0, 1),
    Error,
    "timeline duration 0 must be finite and positive",
  );
  const markup = renderToStaticMarkup(
    <TimelineRuler
      label="Animation"
      duration_seconds={2.5}
      playhead_seconds={1.25}
    />,
  );
  assertStringIncludes(markup, "Animation, 2.5 seconds");
  assertStringIncludes(markup, "Playhead 1.25 seconds");
});

Deno.test("error and unavailable capability states announce failures assertively", () => {
  const error_markup = renderToStaticMarkup(
    <ErrorState title="Import failed" message="Mesh is malformed" />,
  );
  const capability_markup = renderToStaticMarkup(
    <CapabilityState
      capability="WebGPU"
      availability="unavailable"
      detail="Use headless mode"
    />,
  );

  assertStringIncludes(error_markup, 'role="alert"');
  assertStringIncludes(capability_markup, 'role="alert"');
  assertStringIncludes(capability_markup, "WebGPU: unavailable");
});
