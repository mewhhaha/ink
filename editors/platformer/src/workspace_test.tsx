import { assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import { create_platformer_starter } from "./starter.ts";
import { PlatformerWorkspace } from "./workspace.tsx";

Deno.test("platformer workspace presents the authoritative exit edit", () => {
  const markup = renderToStaticMarkup(
    <PlatformerWorkspace
      project={create_platformer_starter("classic-adventure")}
      selected_record_id="level-exit"
      onMoveExit={() => {}}
      onSelectRecord={() => {}}
    />,
  );
  assertStringIncludes(markup, "Classic adventure starter workspace");
  assertStringIncludes(markup, "Level exit · exit");
  assertStringIncludes(markup, "Exit: 28–31 × 2–6");
  assertStringIncludes(markup, "Move exit right");
});
