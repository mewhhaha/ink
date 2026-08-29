import { assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import { GameActionControls } from "./action_controls.tsx";

Deno.test("adventure action controls expose Blot actions and current status", () => {
  const markup = renderToStaticMarkup(
    <GameActionControls
      observation={{
        sequence: 0,
        outcome: "running",
        projection: "orthographic",
        camera_zoom: 1,
        regions: [],
        status: {
          label: "Tower objective",
          value: "defense ready",
          done: false,
        },
        actions: [{
          id: "next-wave",
          label: "Launch next wave",
          action: { type: "activate", target: 0 },
        }],
      }}
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

Deno.test("game action controls present spatial buttons without duplicate focus actions", () => {
  const markup = renderToStaticMarkup(
    <GameActionControls
      observation={{
        sequence: 0,
        outcome: "running",
        projection: "perspective",
        camera_zoom: 1,
        regions: [{
          id: "fire",
          label: "Fire",
          description: "Fire the equipped sidearm.",
          element_size: { width: 120, height: 44 },
          placement: { type: "viewport", anchor: "top_left", inset: [24, 24] },
          style: {
            background_color: "#111827",
            border_color: "#f59e0b",
            border_radius: 6,
            border_width: 1,
            color: "#f9fafb",
            font_size: 14,
            font_weight: 600,
          },
          order: 0,
          role: "button",
          target: 0,
          pressed: false,
          selected: false,
          actions: [],
        }],
        status: {
          label: "Combat drill",
          value: "target engaged",
          done: false,
        },
        actions: [{
          id: "focus:fire",
          label: "Focus fire",
          action: { type: "focus", target: 0 },
        }, {
          id: "activate:fire",
          label: "Activate fire",
          action: { type: "activate", target: 0 },
        }],
      }}
      can_interact
      dispatch_game_action={() => Promise.resolve()}
    />,
  );

  assertStringIncludes(markup, ">Fire</button>");
  if (markup.includes("Focus fire") || markup.includes("Activate fire")) {
    throw new Error(`spatial game actions used host labels: ${markup}`);
  }
});

Deno.test("game action controls stay absent when Blot publishes no actions", () => {
  const markup = renderToStaticMarkup(
    <GameActionControls
      observation={undefined}
      can_interact={false}
      dispatch_game_action={() => Promise.resolve()}
    />,
  );

  if (markup !== "") {
    throw new Error(`empty game action controls rendered ${markup}`);
  }
});

Deno.test("game action controls hide configured actions without changing the observation", () => {
  const observation = {
    sequence: 0,
    outcome: "running",
    projection: "perspective",
    camera_zoom: 1,
    regions: [],
    status: {
      label: "Combat drill",
      value: "moving",
      done: false,
    },
    actions: [{
      id: "fire",
      label: "Fire",
      action: { type: "custom", kind: 1, target: 0, value: 0 },
    }, {
      id: "movement-stop",
      label: "Stop moving",
      action: { type: "custom", kind: 2, target: 0, value: 0 },
    }],
  } as const;

  const markup = renderToStaticMarkup(
    <GameActionControls
      observation={observation}
      can_interact
      dispatch_game_action={() => Promise.resolve()}
      hidden_action_ids={["movement-stop"]}
    />,
  );

  assertStringIncludes(markup, ">Fire</button>");
  if (markup.includes("Stop moving")) {
    throw new Error(`hidden game action was rendered: ${markup}`);
  }
  if (observation.actions.length !== 2) {
    throw new Error("filtering controls changed the game observation");
  }
});
