import { assertEquals, assertThrows } from "@std/assert";
import {
  apply_debugger_action,
  create_debugger_observation_sink,
  type DebuggerCommand,
  DebuggerCommandRegistry,
  initial_debugger_state,
  parse_debugger_command,
} from "./debugger.ts";

Deno.test("debugger command lines preserve quoted and escaped arguments", () => {
  assertEquals(parse_debugger_command("spawn 'red barrel' north\\ west"), [
    "spawn",
    "red barrel",
    "north west",
  ]);
  assertThrows(
    () => parse_debugger_command('spawn "red barrel'),
    Error,
    'unterminated " quote',
  );
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

Deno.test("debugger registries execute registered commands and reject duplicates", async () => {
  const command: DebuggerCommand = {
    name: "echo",
    usage: "echo <message>",
    description: "Print a message.",
    execute: (arguments_) => arguments_.join(" "),
  };
  const registry = new DebuggerCommandRegistry([command]);

  assertEquals(await registry.execute('echo "hello world"'), "hello world");
  assertThrows(
    () => registry.register(command),
    Error,
    'debugger command "echo" is already registered',
  );
});

Deno.test("debugger completion covers command names and registered arguments", () => {
  const registry = new DebuggerCommandRegistry([{
    name: "gizmos",
    usage: "gizmos <all|none|collisions|areas>",
    description: "Choose visible gizmos.",
    complete: () => ["none", "all", "areas", "collisions", "all"],
    execute: () => "",
  }, {
    name: "help",
    usage: "help",
    description: "List commands.",
    execute: () => "",
  }]);

  assertEquals(registry.completions("g"), ["gizmos"]);
  assertEquals(registry.completions("gizmos a"), ["all", "areas"]);
  assertEquals(registry.complete("gizmos a", "areas"), "gizmos areas");
  assertEquals(
    registry.help(),
    "gizmos <all|none|collisions|areas> — Choose visible gizmos.\nhelp — List commands.",
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

Deno.test("debugger windows retain readable dimensions while resizing", () => {
  assertEquals(
    apply_debugger_action(initial_debugger_state, {
      type: "resize",
      size: { width: 520.4, height: 340.6 },
    }).size,
    { width: 520, height: 341 },
  );
  assertEquals(
    apply_debugger_action(initial_debugger_state, {
      type: "resize",
      size: { width: 40, height: 20 },
    }).size,
    { width: 280, height: 160 },
  );
});
