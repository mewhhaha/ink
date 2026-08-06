import { assertEquals } from "@std/assert";
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
    lifecycle_target: lifecycle,
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

Deno.test("browser gamepad polling reports connection controls and disconnection", () => {
  let connected = true;
  const gamepad = {
    connected: true,
    id: "Test Pad",
    index: 0,
    buttons: [{ pressed: true, touched: true, value: 1 }],
    axes: [0.25],
  } as unknown as Gamepad;
  const target = new EventTarget();
  const adapter = new BrowserInputAdapter({
    keyboard_target: target,
    pointer_target: target,
    lifecycle_target: target,
    get_gamepads: () => connected ? [gamepad] : [],
    xr: { snapshots: () => [{ id: "left", buttons: [0.75], axes: [-0.5] }] },
  });
  const first = adapter.capture(frame_id(0));
  assertEquals(first.lifecycle.map((event) => event.type), [
    "connected",
    "connected",
  ]);
  assertEquals(first.controls.length, 6);
  connected = false;
  const second = adapter.capture(frame_id(1));
  assertEquals(
    second.lifecycle.some((event) => event.type === "disconnected"),
    true,
  );
  const released = second.controls.find((control) =>
    control.device.kind === "gamepad" && control.type === "button"
  );
  if (released?.type !== "button") {
    throw new Error("gamepad button was not retained for release");
  }
  assertEquals(released.pressed, false);
  adapter.dispose();
});
