import { assertEquals, assertThrows } from "@std/assert";
import { Observer } from "@ink/observability/observer.ts";
import {
  apply_debugger_action,
  create_debugger_observation_log,
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

Deno.test("debugger observation logs redact sensitive evidence before retention and presentation", () => {
  const actions: unknown[] = [];
  const log = create_debugger_observation_log({
    capacity: 2,
    record: (action) => actions.push(action),
  });
  log.record({
    type: "span",
    id: "runtime:0",
    name: "frame",
    source: { subsystem: "runtime", instance: "main" },
    timestamp_seconds: 1,
    duration_seconds: 0.0125,
    context: {},
    evidence: {
      game_text: "secret",
      nested: { file_path: "/private/save", count: 2 },
      room: "gate",
    },
  });

  assertEquals(actions, [{
    type: "record",
    kind: "runtime",
    message:
      '[runtime/main] frame 12.500 ms game_text="[redacted]" nested={"count":2,"file_path":"[redacted]"} room="gate"',
  }]);
  const retained = log.observations()[0];
  assertEquals(retained.type === "span" ? retained.evidence : {}, {
    game_text: "[redacted]",
    nested: { file_path: "[redacted]", count: 2 },
    room: "gate",
  });
});

Deno.test("observer diagnostics reach the debugger with actionable evidence", () => {
  const actions: unknown[] = [];
  const log = create_debugger_observation_log({
    capacity: 2,
    record: (action) => actions.push(action),
  });
  const observer = new Observer({
    source: { subsystem: "runtime" },
    sink: log,
    clock: { now_seconds: () => 1 },
  });

  observer.diagnostic(
    "error",
    "runtime.reload",
    "replacement rejected",
    { artifact: "bad-revision", file_path: "/private/game.wasm" },
  );

  assertEquals(actions, [{
    type: "record",
    kind: "error",
    message:
      '[runtime] runtime.reload: replacement rejected artifact="bad-revision" file_path="[redacted]"',
  }]);
});

Deno.test("debugger observation logs evict the oldest retained record deterministically", () => {
  const log = create_debugger_observation_log({
    capacity: 2,
    record() {},
  });
  for (const name of ["first", "second", "third"]) {
    log.record({
      type: "event",
      name,
      source: { subsystem: "runtime" },
      timestamp_seconds: 1,
      context: {},
      evidence: {},
    });
  }

  assertEquals(
    log.observations().map((observation) =>
      observation.type === "event" ? observation.name : observation.type
    ),
    ["second", "third"],
  );
  assertEquals(log.dropped(), 1);
});

Deno.test("debugger observation logs retain records when the presentation adapter fails", () => {
  const log = create_debugger_observation_log({
    capacity: 2,
    record() {
      throw new Error("debugger unavailable");
    },
  });
  log.record({
    type: "diagnostic",
    severity: "error",
    operation: "runtime.reload",
    message: "replacement rejected",
    source: { subsystem: "runtime" },
    timestamp_seconds: 1,
    context: {},
    evidence: { artifact: "bad-revision" },
  });

  assertEquals(log.observations().length, 1);
  assertEquals(log.failures(), [{
    sink_index: 1,
    reason: "debugger unavailable",
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
