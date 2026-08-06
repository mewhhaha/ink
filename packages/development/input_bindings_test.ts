import { assertEquals } from "@std/assert";
import {
  create_keyboard_input_controller,
  game_surface_owns_pointer_lock,
} from "./input_bindings.ts";

Deno.test("game surface owns pointer lock through its canvas or shadow host", () => {
  const canvas = {};
  const surface = { canvas };

  assertEquals(game_surface_owns_pointer_lock(surface, canvas), true);
  assertEquals(game_surface_owns_pointer_lock(surface, surface), true);
  assertEquals(game_surface_owns_pointer_lock(surface, {}), false);
  assertEquals(game_surface_owns_pointer_lock(surface, null), false);
  assertEquals(game_surface_owns_pointer_lock(null, surface), false);
});

Deno.test("one-shot bindings dispatch once and ignore key repeat", () => {
  const dispatched: string[] = [];
  const input = create_keyboard_input_controller(
    { " ": "jump" },
    (action_id) => dispatched.push(action_id),
  );

  assertEquals(input.press(" ", "Space", false), true);
  assertEquals(input.press(" ", "Space", true), true);
  assertEquals(input.release("Space"), false);
  assertEquals(dispatched, ["jump"]);
});

Deno.test("continuous bindings dispatch their press and release actions", () => {
  const dispatched: string[] = [];
  const input = create_keyboard_input_controller(
    { w: { pressed: "forward-start", released: "forward-stop" } },
    (action_id) => dispatched.push(action_id),
  );

  input.press("W", "KeyW", false);
  input.press("w", "KeyW", true);
  input.release("KeyW");

  assertEquals(dispatched, ["forward-start", "forward-stop"]);
});

Deno.test("equivalent held keys release only after the last key", () => {
  const dispatched: string[] = [];
  const movement = { pressed: "forward-start", released: "forward-stop" };
  const input = create_keyboard_input_controller(
    { w: movement, arrowup: movement },
    (action_id) => dispatched.push(action_id),
  );

  input.press("w", "KeyW", false);
  input.press("ArrowUp", "ArrowUp", false);
  input.release("KeyW");
  assertEquals(dispatched, ["forward-start"]);
  input.release("ArrowUp");
  assertEquals(dispatched, ["forward-start", "forward-stop"]);
});

Deno.test("releasing all held inputs stops every active binding", () => {
  const dispatched: string[] = [];
  const input = create_keyboard_input_controller(
    {
      a: { pressed: "left-start", released: "left-stop" },
      w: { pressed: "forward-start", released: "forward-stop" },
    },
    (action_id) => dispatched.push(action_id),
  );

  input.press("a", "KeyA", false);
  input.press("w", "KeyW", false);
  input.release_all();

  assertEquals(dispatched, [
    "left-start",
    "forward-start",
    "left-stop",
    "forward-stop",
  ]);
});
