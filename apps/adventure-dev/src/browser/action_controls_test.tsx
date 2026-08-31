import type { ActionDescription, GameObservation } from "@ink/blot/protocol.ts";
import { literal_text, ui_id } from "@ink/ui/semantic.ts";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import { GameActionControls } from "./action_controls.tsx";

function observation(
  actions: readonly ActionDescription[],
  status = { label: "Tower objective", value: "defense ready", done: false },
): GameObservation {
  return {
    sequence: 0,
    outcome: "running",
    status,
    actions,
    ui: {
      revision: 0,
      direction: "auto",
      root: {
        id: ui_id("blot.game"),
        role: "region",
        label: literal_text(status.label),
        description: literal_text(status.value),
        layout: { type: "absolute" },
        children: [],
        actions: actions.filter(({ trigger }) => trigger.type === "command"),
      },
      announcements: [],
    },
  };
}

Deno.test("adventure action controls expose Blot commands and current status", () => {
  const markup = renderToStaticMarkup(
    <GameActionControls
      observation={observation([{
        id: "next-wave",
        label: literal_text("Launch next wave"),
        trigger: { type: "command" },
        action: { type: "custom", kind: 1, target: 0, value: 0 },
      }])}
      can_interact={false}
      dispatch_game_action={() => Promise.resolve()}
    />,
  );

  assertStringIncludes(markup, "Tower objective");
  assertStringIncludes(markup, "defense ready");
  assertStringIncludes(markup, "Launch next wave");
  assertStringIncludes(markup, "disabled");
  assertStringIncludes(markup, "Press Play to enable these actions.");
});

Deno.test("game action controls leave spatial buttons to the canonical UI adapter", () => {
  const markup = renderToStaticMarkup(
    <GameActionControls
      observation={observation([{
        id: "focus:fire",
        label: literal_text("Focus fire"),
        trigger: { type: "focus", target: ui_id("fire") },
        action: { type: "focus", target: 0 },
      }, {
        id: "activate:fire",
        label: literal_text("Activate fire"),
        trigger: { type: "activate", target: ui_id("fire") },
        action: { type: "activate", target: 0 },
      }])}
      can_interact
      dispatch_game_action={() => Promise.resolve()}
    />,
  );

  assertEquals(markup, "");
});

Deno.test("game action controls stay absent when Blot publishes no actions", () => {
  const markup = renderToStaticMarkup(
    <GameActionControls
      observation={undefined}
      can_interact={false}
      dispatch_game_action={() => Promise.resolve()}
    />,
  );

  assertEquals(markup, "");
});

Deno.test("game action controls hide configured actions without changing the observation", () => {
  const current = observation([{
    id: "fire",
    label: literal_text("Fire"),
    trigger: { type: "command" },
    action: { type: "custom", kind: 1, target: 0, value: 0 },
  }, {
    id: "movement-stop",
    label: literal_text("Stop moving"),
    trigger: { type: "command" },
    action: { type: "custom", kind: 2, target: 0, value: 0 },
  }], {
    label: "Combat drill",
    value: "moving",
    done: false,
  });

  const markup = renderToStaticMarkup(
    <GameActionControls
      observation={current}
      can_interact
      dispatch_game_action={() => Promise.resolve()}
      hidden_action_ids={["movement-stop"]}
    />,
  );

  assertStringIncludes(markup, ">Fire</button>");
  if (markup.includes("Stop moving")) {
    throw new Error(`hidden game action was rendered: ${markup}`);
  }
  assertEquals(current.actions.length, 2);
});
