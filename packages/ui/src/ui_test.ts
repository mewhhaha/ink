import { assertEquals } from "@std/assert";
import { vec2, vec3 } from "@ink/math/vector.ts";
import { frame_id } from "@ink/runtime/frame.ts";
import { action_id } from "@ink/input/model.ts";
import { ui_actions_from_input_frame, UiController } from "./controller.ts";
import { layout_ui } from "./layout.ts";
import {
  literal_text,
  type SemanticNode,
  ui_id,
  type UiSnapshot,
  UiSnapshotStore,
} from "./semantic.ts";

function button(
  id: string,
  options: Partial<Extract<SemanticNode, { role: "button" }>> = {},
): SemanticNode {
  return {
    id: ui_id(id),
    role: "button",
    label: literal_text(id),
    size: { width: 40, height: 20 },
    ...options,
  };
}

function snapshot(
  revision: number,
  children: readonly SemanticNode[],
  direction: UiSnapshot["direction"] = "ltr",
): UiSnapshot {
  return {
    revision,
    direction,
    root: {
      id: ui_id("root"),
      role: "region",
      label: literal_text("Interface"),
      layout: { type: "flex", direction: "row", gap: 10, padding: 5 },
      children,
    },
    announcements: [],
  };
}

Deno.test("snapshot store rejects duplicates and retains the last complete revision", () => {
  const store = new UiSnapshotStore();
  const accepted = snapshot(1, [button("one")]);
  assertEquals(store.replace(accepted).type, "accepted");
  assertEquals(Object.isFrozen(store.current()), true);
  assertEquals(Object.isFrozen(store.current()?.root), true);
  const rejected = store.replace(snapshot(2, [button("same"), button("same")]));
  assertEquals(rejected.type, "rejected");
  assertEquals(store.current(), accepted);
  const malformed = snapshot(2, [button("valid")]);
  (malformed.root as { layout: unknown }).layout = {
    type: "flex",
    direction: "diagonal",
    gap: 0,
    padding: 0,
  };
  assertEquals(store.replace(malformed).type, "rejected");
});

Deno.test("flex layout applies player scale, gap, padding, and RTL ordering", () => {
  const result = layout_ui(
    snapshot(1, [button("first"), button("second")], "rtl"),
    {
      viewport: vec2(200, 100),
      player_scale: 2,
      reduced_motion: true,
    },
  );
  if (result.type !== "ready") throw new Error(result.reason);
  const first = result.entries.find((entry) => entry.id === "first")!;
  const second = result.entries.find((entry) => entry.id === "second")!;
  assertEquals(second.rect, { x: 10, y: 10, width: 80, height: 40 });
  assertEquals(first.rect, { x: 110, y: 10, width: 80, height: 40 });
  assertEquals(result.reduced_motion, true);

  const hidden = layout_ui(
    snapshot(2, [button("hidden", { hidden: true }), button("visible")]),
    {
      viewport: vec2(200, 100),
      player_scale: 1,
      reduced_motion: false,
    },
  );
  if (hidden.type !== "ready") throw new Error(hidden.reason);
  assertEquals(hidden.entries.some((entry) => entry.id === "hidden"), false);
  assertEquals(
    hidden.entries.find((entry) => entry.id === "visible")?.rect.x,
    5,
  );
});

Deno.test("grid and absolute layout handle empty space and explicit placement", () => {
  const root: SemanticNode = {
    id: ui_id("root"),
    role: "region",
    label: literal_text("Grid"),
    layout: { type: "grid", columns: 2, gap: 4, padding: 0 },
    children: [
      button("a"),
      button("b"),
      button("c", {
        placement: { type: "absolute", x: 7, y: 8, width: 9, height: 10 },
      }),
    ],
  };
  const result = layout_ui({
    revision: 1,
    direction: "ltr",
    root,
    announcements: [],
  }, {
    viewport: vec2(104, 100),
    player_scale: 1,
    reduced_motion: false,
  });
  if (result.type !== "ready") throw new Error(result.reason);
  assertEquals(
    result.entries.find((entry) => entry.id === "a")?.rect.width,
    50,
  );
  assertEquals(result.entries.find((entry) => entry.id === "c")?.rect, {
    x: 7,
    y: 8,
    width: 9,
    height: 10,
  });
});

Deno.test("scene attachment uses the injected camera boundary and rejects unavailable projection", () => {
  const attached = button("attached", {
    placement: {
      type: "scene",
      node: { index: 2, generation: 0 } as never,
      offset: vec3(0, 1, 0),
      size: vec2(2, 1),
    },
  });
  const ready = layout_ui(snapshot(1, [attached]), {
    viewport: vec2(100, 100),
    player_scale: 1,
    reduced_motion: false,
    scene: { project: () => ({ x: 20, y: 30, width: 40, height: 10 }) },
  });
  if (ready.type !== "ready") throw new Error(ready.reason);
  assertEquals(ready.entries.find((entry) => entry.id === "attached")?.rect, {
    x: 20,
    y: 30,
    width: 40,
    height: 10,
  });
  assertEquals(
    layout_ui(snapshot(1, [attached]), {
      viewport: vec2(100, 100),
      player_scale: 1,
      reduced_motion: false,
    }),
    {
      type: "rejected",
      node: ui_id("attached"),
      reason: "scene attachment could not be projected",
    },
  );
  assertEquals(
    layout_ui(snapshot(1, [attached]), {
      viewport: vec2(100, 100),
      player_scale: 1,
      reduced_motion: false,
      scene: {
        project: () => ({ x: 0, y: 0, width: Number.NaN, height: 1 }),
      },
    }).type,
    "rejected",
  );
});

Deno.test("focus persists by identity and moves when the retained node becomes disabled", () => {
  const initial = snapshot(1, [button("first"), button("second")]);
  const layout = layout_ui(initial, {
    viewport: vec2(200, 100),
    player_scale: 1,
    reduced_motion: false,
  });
  if (layout.type !== "ready") throw new Error(layout.reason);
  const controller = new UiController();
  controller.update(initial, layout.entries);
  assertEquals(controller.dispatch({ type: "navigate", direction: "next" }), [{
    type: "focus_changed",
    target: ui_id("first"),
  }]);
  assertEquals(controller.dispatch({ type: "navigate", direction: "right" }), [{
    type: "focus_changed",
    target: ui_id("second"),
  }]);
  const updated = snapshot(2, [
    button("first"),
    button("second", { disabled: true }),
  ]);
  const next_layout = layout_ui(updated, {
    viewport: vec2(200, 100),
    player_scale: 1,
    reduced_motion: false,
  });
  if (next_layout.type !== "ready") throw new Error(next_layout.reason);
  assertEquals(controller.update(updated, next_layout.entries), [{
    type: "focus_changed",
    target: ui_id("first"),
  }]);
});

Deno.test("modal regions contain focus and disabled controls cannot activate", () => {
  const modal: SemanticNode = {
    id: ui_id("modal"),
    role: "region",
    label: literal_text("Modal"),
    modal: true,
    layout: { type: "flex", direction: "column", gap: 0, padding: 0 },
    children: [button("enabled"), button("disabled", { disabled: true })],
  };
  const value = snapshot(1, [button("outside"), modal]);
  const layout = layout_ui(value, {
    viewport: vec2(200, 100),
    player_scale: 1,
    reduced_motion: false,
  });
  if (layout.type !== "ready") throw new Error(layout.reason);
  const controller = new UiController();
  controller.update(value, layout.entries);
  controller.dispatch({ type: "navigate", direction: "next" });
  assertEquals(controller.focused(), ui_id("enabled"));
  assertEquals(
    controller.dispatch({ type: "activate", target: ui_id("disabled") }),
    [],
  );
});

Deno.test("slider changes snap to steps and private edits remain normalized actions", () => {
  const root: SemanticNode = {
    id: ui_id("root"),
    role: "region",
    label: literal_text("Form"),
    layout: { type: "flex", direction: "column", gap: 0, padding: 0 },
    children: [
      {
        id: ui_id("volume"),
        role: "slider",
        label: literal_text("Volume"),
        minimum: 0,
        maximum: 10,
        value: 5,
        step: 2,
      },
      {
        id: ui_id("secret"),
        role: "text_input",
        label: literal_text("Secret"),
        value: "",
        private: true,
      },
    ],
  };
  const value = {
    revision: 1,
    direction: "ltr" as const,
    root,
    announcements: [],
  };
  const layout = layout_ui(value, {
    viewport: vec2(100, 100),
    player_scale: 1,
    reduced_motion: false,
  });
  if (layout.type !== "ready") throw new Error(layout.reason);
  const controller = new UiController();
  controller.update(value, layout.entries);
  assertEquals(
    controller.dispatch({
      type: "change",
      target: ui_id("volume"),
      value: 7.1,
    }),
    [{ type: "value_changed", target: ui_id("volume"), value: 8 }],
  );
  assertEquals(
    controller.dispatch({
      type: "change",
      target: ui_id("volume"),
      value: Number.NaN,
    }),
    [],
  );
  assertEquals(
    controller.dispatch({
      type: "text_edit",
      target: ui_id("secret"),
      value: "password",
    }),
    [{ type: "text_edited", target: ui_id("secret"), value: "password" }],
  );
});

Deno.test("input frames normalize navigation and activation without browser events", () => {
  const devices = {
    frame_id: frame_id(3),
    focused: true,
    controls: [],
    contacts: [],
    lifecycle: [],
  };
  assertEquals(
    ui_actions_from_input_frame({
      frame_id: frame_id(3),
      devices,
      actions: [
        {
          id: action_id("ui.next"),
          context: "ui",
          value: { type: "digital", pressed: true, phase: "pressed" },
        },
        {
          id: action_id("ui.activate"),
          context: "ui",
          value: { type: "digital", pressed: true, phase: "pressed" },
        },
      ],
    }),
    [{ type: "navigate", direction: "next" }, { type: "activate" }],
  );
});
