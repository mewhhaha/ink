import { assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import { axis2, button, defineSchema } from "@ink/schema";
import { InputState } from "@ink/core/input";
import { pollGamepad } from "./devices.ts";

Deno.test("device input combines analog sources, preserves button edges and releases on disconnect", () => {
  const schema = defineSchema({
    actions: {
      move: axis2({
        left: ["KeyA"],
        right: ["KeyD"],
        up: ["KeyW"],
        down: ["KeyS"],
      }),
      jump: button("Space"),
    },
  });
  const input = new InputState(schema);
  let keys = pollGamepad(input, {
    axes: [0.575, 0.1],
    buttons: [{ pressed: true, value: 1 }],
    connected: true,
  });
  let sample = input.sample(0, 1 / 60, 0);
  assertAlmostEquals((sample.actions.move as number[])[0], 0.5, 1e-6);
  assertEquals((sample.actions.move as number[])[1], 0);
  assertEquals(sample.actions.jump, {
    down: true,
    pressed: true,
    released: false,
  });
  input.keyDown("Space");
  sample = input.sample(1, 1 / 60, 1 / 60);
  assertEquals(sample.actions.jump, {
    down: true,
    pressed: false,
    released: false,
  });
  input.keyUp("Space");
  assertEquals(input.sample(2, 1 / 60, 2 / 60).actions.jump, {
    down: true,
    pressed: false,
    released: false,
  });
  keys = pollGamepad(input, null, keys);
  assertEquals(keys.size, 0);
  assertEquals(input.sample(3, 1 / 60, 3 / 60).actions.jump, {
    down: false,
    pressed: false,
    released: true,
  });
  input.hold("jump", true);
  assertEquals(input.sample(4, 1 / 60, 4 / 60).actions.jump, {
    down: true,
    pressed: true,
    released: false,
  });
  input.hold("jump", false);
  assertEquals(input.sample(5, 1 / 60, 5 / 60).actions.jump, {
    down: false,
    pressed: false,
    released: true,
  });
  input.bind("jump", "keys", ["KeyJ"]);
  input.keyDown("Space");
  assertEquals(input.sample(6, 1 / 60, 6 / 60).actions.jump, {
    down: false,
    pressed: false,
    released: false,
  });
  input.keyDown("KeyJ");
  assertEquals(input.sample(7, 1 / 60, 7 / 60).actions.jump, {
    down: true,
    pressed: true,
    released: false,
  });
  assertEquals(
    schema.actions.find((a) => a.name === "jump")!.action,
    button("Space"),
  );
  assertThrows(() => input.bind("jump", "left", ["KeyA"]));
  input.device("touch", { move: [1, 1] });
  const move = input.sample(8, 1 / 60, 8 / 60).actions.move as number[];
  assertAlmostEquals(Math.hypot(...move), 1, 1e-6);
  input.reset();
  input.hold("jump", true);
  input.hold("jump", false);
  assertEquals(input.sample(0, 1 / 60, 0).actions.jump, {
    down: false,
    pressed: true,
    released: true,
  }, "a touch tap shorter than a tick still jumps");
});
