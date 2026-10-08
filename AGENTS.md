# Project intent

Ink is a foundation for building specialized game-development environments, not
a single general-purpose game editor. The point is iteration speed: code, data,
assets and UI all change in place while the game keeps running.

Work fits into three layers:

1. **Core packages** (`packages/`) provide game-neutral capabilities: the schema
   and packed state, the Blot boundary, the session (edit/play, history,
   timeline, input, comments, hand-offs), the renderer, UI building blocks,
   brush tools, and the dev server/CLI.
2. **Specialized editors** compose those into an opinionated workflow for a
   genre (the Godot-, TrenchBroom- and Hammer-like editors in `examples/`). They
   own their panels, defaults, tools and vocabulary.
3. **Games** are a schema, Blot code, scenes and assets that an editor opens.

Source dependencies point toward the more general layer. Core packages never
depend on an editor or a game. Put behaviour in the narrowest layer that can
honestly own it; promote it into core only when it is game-neutral and useful to
different editors.

The browser makes specialization cheap: prefer ordinary React, HTML, CSS and
explicit session APIs over a universal editor abstraction.

# Working here

- No backward compatibility: change formats and APIs freely, delete old paths.
- Read `docs/architecture.md`; read `docs/blot.md` before writing Blot and add
  any compiler quirk you discover to it.
- The game owns no state between steps: `step(input, world) -> world`. Keep
  presentation (editor cameras, selection, hover) out of game state.
- Verify visible changes in a browser, not only with tests: run
  `deno task ink dev <project>` and drive it (headless Chromium with SwiftShader
  WebGPU works; see `docs/agents.md`), or `deno task ink capture`, and look at
  the pictures.
- `deno task check` and `deno task test` before handing work back.
