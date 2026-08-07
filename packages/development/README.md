# @ink/development

The debugger window is an embeddable command history and text input. Commands
are ordinary registered values, so a specialized editor can add vocabulary
without changing the debugger component:

```tsx
const commands = new DebuggerCommandRegistry();

commands.register({
  name: "spawn",
  usage: "spawn <fixture>",
  description: "Spawn a test fixture.",
  complete: () => ["barrel", "crate"],
  execute: ([fixture]) => {
    if (!fixture) throw new Error("spawn requires one fixture");
    spawn_fixture(fixture);
    return `spawned ${fixture}`;
  },
});

<DebuggerWindow commands={commands} runtime_message="Ready" />;
```

`GameDevelopment` registers playback, semantic action, status, history, help,
and gizmo commands. Its `debugger_commands` property adds specialized commands
to that registry. `gizmos all`, `gizmos none`, `gizmos collisions`, and
`gizmos areas` update the `gizmo_visibility` exposed to the specialized editor
context. Physics snapshots can turn that selection into wire primitives with
`collision_gizmos` from `@ink/physics/gizmos.ts`.

Command lines accept quoted and escaped arguments. Tab completes registered
command names and command-provided arguments; Up and Down navigate command
history.
