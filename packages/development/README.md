# @ink/development

`DevelopmentController` serializes load, advance, observe, reload, replay, and
close operations around a runtime session. Its snapshot retains the last good
game observation when a reload fails.

`create_debugger_observation_log` is the development observation boundary. It
redacts sensitive evidence before retaining or formatting a record, keeps the
configured number of newest records, and reports both record eviction and
debugger adapter failures. Pass the log itself to `Observer`:

```ts
let debugger_state = initial_debugger_state;
const observations = create_debugger_observation_log({
  capacity: 100,
  record(action) {
    debugger_state = apply_debugger_action(debugger_state, action);
  },
});
const observer = new Observer({
  source: { subsystem: "adventure" },
  sink: observations,
  clock,
});
```

The retained `observations()` remain structured and redacted. Debugger messages
include sorted evidence fields so a failure keeps its artifact, operation, or
entity identity without exposing file paths, network addresses, or game text.

`DebuggerCommandRegistry` owns command parsing, execution, help, and completion.
Command lines accept quoted and escaped arguments. `DebuggerWindow` provides the
command history and text input UI.
