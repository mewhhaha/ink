import { assertEquals } from "@std/assert";
import type { GameObservation } from "@ink/engine/protocol.ts";
import { city_pointer_action, city_tools } from "../src/city_editor_logic.ts";

const observation: GameObservation = {
  sequence: 0,
  outcome: "running",
  projection: "orthographic",
  camera_zoom: 0.25,
  regions: [],
  status: { label: "Map", value: "Population 0; active fires 0", done: false },
  actions: [
    {
      id: "city-tool-path",
      label: "Path",
      action: { type: "custom", kind: 10, target: 1, value: 1 },
    },
    {
      id: "city-tool-plot",
      label: "Housing plot",
      action: { type: "custom", kind: 10, target: 2, value: 0 },
    },
    {
      id: "city-tool-well",
      label: "Well",
      action: { type: "custom", kind: 10, target: 4, value: 0 },
    },
    {
      id: "city-tool-marshal",
      label: "Fire marshal post",
      action: { type: "custom", kind: 10, target: 6, value: 0 },
    },
    {
      id: "city-paint-tile",
      label: "Paint",
      action: { type: "custom", kind: 11, target: 0, value: 0 },
    },
  ],
};

Deno.test("the city palette follows game-published tool state", () => {
  assertEquals(city_tools(observation), [
    {
      id: "city-tool-path",
      label: "Path",
      selected: true,
      action: { type: "custom", kind: 10, target: 1, value: 1 },
    },
    {
      id: "city-tool-plot",
      label: "Housing plot",
      selected: false,
      action: { type: "custom", kind: 10, target: 2, value: 0 },
    },
    {
      id: "city-tool-well",
      label: "Well",
      selected: false,
      action: { type: "custom", kind: 10, target: 4, value: 0 },
    },
    {
      id: "city-tool-marshal",
      label: "Fire marshal post",
      selected: false,
      action: { type: "custom", kind: 10, target: 6, value: 0 },
    },
  ]);
});

Deno.test("a canvas point maps to the game paint action for its isometric tile", () => {
  assertEquals(
    city_pointer_action({
      x: 500,
      y: 506.3,
      width: 1_000,
      height: 1_000,
      observation,
    }),
    {
      type: "custom",
      kind: 11,
      target: 495,
      value: 0,
    },
  );
});
