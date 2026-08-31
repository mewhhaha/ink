import { assertEquals } from "@std/assert";
import { Observer } from "@ink/observability/observer.ts";
import { create_test_sink } from "@ink/observability/sink.ts";
import { frame_id } from "@ink/runtime/frame.ts";
import { BrowserInputAdapter } from "./browser.ts";

function platform_event(
  type: string,
  properties: Readonly<Record<string, unknown>>,
): Event {
  const event = new Event(type);
  for (const [name, value] of Object.entries(properties)) {
    Object.defineProperty(event, name, { value });
  }
  return event;
}

Deno.test("browser keyboard pointer and wheel events normalize without escaping DOM events", () => {
  const keyboard = new EventTarget();
  const pointer = new EventTarget();
  const lifecycle = new EventTarget();
  const adapter = new BrowserInputAdapter({
    keyboard_target: keyboard,
    pointer_target: pointer,
    focus_target: lifecycle,
    pointer_lock_target: lifecycle,
  });
  keyboard.dispatchEvent(
    platform_event("keydown", { code: "KeyW", repeat: false }),
  );
  pointer.dispatchEvent(
    platform_event("pointerdown", { pointerId: 4, button: 0 }),
  );
  pointer.dispatchEvent(platform_event("pointermove", {
    pointerId: 4,
    clientX: 10,
    clientY: 20,
    movementX: 3,
    movementY: -2,
  }));
  pointer.dispatchEvent(platform_event("wheel", { deltaX: 0, deltaY: -30 }));
  const captured = adapter.capture(frame_id(0));
  assertEquals(
    captured.controls.map((control) =>
      `${control.device.kind}/${control.control}/${control.type}`
    ),
    [
      "keyboard/key:KeyW/button",
      "pointer/button:0/button",
      "pointer/delta/axis2",
      "pointer/position/axis2",
      "pointer/wheel/axis2",
    ],
  );
  assertEquals(captured.controls.some((control) => "code" in control), false);
  lifecycle.dispatchEvent(new Event("blur"));
  const lost = adapter.capture(frame_id(1));
  assertEquals(lost.focused, false);
  assertEquals(
    lost.controls.filter((control) => control.type === "button").every((
      control,
    ) => !control.pressed),
    true,
  );
  adapter.dispose();
});

Deno.test("browser input rejects malformed pointer events with diagnostic evidence", () => {
  const target = new EventTarget();
  const sink = create_test_sink();
  const adapter = new BrowserInputAdapter({
    keyboard_target: target,
    pointer_target: target,
    focus_target: target,
    pointer_lock_target: target,
    observer: new Observer({
      source: { subsystem: "browser_input" },
      sink,
      clock: { now_seconds: () => 0 },
    }),
  });

  target.dispatchEvent(platform_event("pointermove", {
    pointerId: 4,
    clientX: Number.NaN,
    clientY: 20,
    movementX: 3,
    movementY: -2,
  }));

  assertEquals(adapter.capture(frame_id(0)).controls, []);
  const diagnostic = sink.observations()[0];
  assertEquals(diagnostic?.type, "diagnostic");
  if (diagnostic?.type === "diagnostic") {
    assertEquals(diagnostic.operation, "pointer_move");
    assertEquals(diagnostic.evidence.evidence, "NaN,20,3,-2");
  }
  adapter.dispose();
});
