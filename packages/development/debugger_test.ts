import { assertEquals, assertThrows } from "@std/assert";
import {
  apply_debugger_action,
  create_debugger_observation_sink,
  initial_debugger_state,
  parse_debugger_command,
} from "./debugger.ts";

Deno.test("debugger commands parse game actions", () => {
  assertEquals(parse_debugger_command("activate 12"), {
    type: "game_action",
    action: { type: "activate", target: 12 },
  });
  assertEquals(parse_debugger_command("custom 7 8 9"), {
    type: "game_action",
    action: { type: "custom", kind: 7, target: 8, value: 9 },
  });
});

Deno.test("debugger observation sinks present structured runtime records without evidence payloads", () => {
  const actions: unknown[] = [];
  const sink = create_debugger_observation_sink((action) =>
    actions.push(action)
  );
  sink.record({
    type: "span",
    id: "runtime:0",
    name: "frame",
    source: { subsystem: "runtime", instance: "main" },
    timestamp_seconds: 1,
    duration_seconds: 0.0125,
    context: {},
    evidence: { game_text: "secret" },
  });

  assertEquals(actions, [{
    type: "record",
    kind: "runtime",
    message: "[runtime/main] frame 12.500 ms",
  }]);
});

Deno.test("debugger commands reject malformed targets", () => {
  assertThrows(
    () => parse_debugger_command("focus tile-4"),
    Error,
    'target "tile-4" must be a nonnegative integer',
  );
});

Deno.test("debugger history retains the latest one hundred entries", () => {
  let state = initial_debugger_state;
  for (let index = 0; index < 101; index += 1) {
    state = apply_debugger_action(state, {
      type: "record",
      kind: "runtime",
      message: `entry ${index}`,
    });
  }

  assertEquals(state.history.length, 100);
  assertEquals(state.history[0], {
    id: 1,
    kind: "runtime",
    message: "entry 1",
  });
});
