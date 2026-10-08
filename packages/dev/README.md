# @ink/dev

Dev tooling for an Ink project: a Vite plugin (compile, codegen, dev API, HMR
events), a browser client, a CLI, and the contract agents use to capture states.
Everything runs under Deno, including Vite.

| Import                | What                                                             |
| --------------------- | ---------------------------------------------------------------- |
| `@ink/dev`            | `defineProject`, protocol types, automation types (browser-safe) |
| `@ink/dev/client`     | `createDevClient()` for the browser                              |
| `@ink/dev/vite`       | `ink(projectDir, config?)` Vite plugin (Deno only)               |
| `@ink/dev/cli`        | the CLI; `startServer(project)` is exported for scripts          |
| `@ink/dev/automation` | `InkAutomation` and its option types                             |
| `@ink/dev/node`       | project resolution and schema loading (Deno only)                |
| `@ink/dev/catalog`    | asset catalog scanning (Deno only)                               |

## Project

```ts
// ink.config.ts
import { defineProject } from "@ink/dev";
export default defineProject({
  title: "My game", /* schema, game, scenes, assets, vite */
});
```

Defaults: `schema.ts`, `game/main.blot`, `scenes/`, `assets/`. `.ink/` holds
`comments.json`, `captures/<id>/`, `handoffs/<id>/`.

## Schema loading and HMR (design)

`schema.ts` is the only definition (`export default defineSchema({...})`).

- The server imports it natively with a `?t=<n>` cache-buster on every change to
  generate `game/schema.gen.blot` and rebuild.
- The browser imports the **same file** through Vite from
  `ProjectInfo.schemaUrl` (`/@fs/.../schema.ts?ink=<version>`);
  `client.loadSchema(project)` does that. The version changes on every
  successful schema reload, so the browser re-evaluates the module.
- The plugin swallows Vite's own HMR for Ink-owned files, so a schema edit
  becomes one `ink:project` event and never a page reload. The app re-imports,
  migrates its state (`migrateWorld`) and carries on.
- A schema that throws becomes `ink:diagnostics`; the old schema stays live.
- Limitation: only `schema.ts` itself is cache-busted natively. If it imports
  helper modules, edits to those are not picked up by the server until
  `schema.ts` is touched (the browser side is fine).

## Endpoints (`/__ink/...`, JSON unless noted)

| Request                                    | Result                                                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `GET project`                              | `{ title, catalog, scenes, game: {revision,url,ms}\|null, diagnostics, schemaUrl }`                |
| `GET game/<revision>.wasm`                 | wasm (last 4 revisions are kept)                                                                   |
| `GET assets/<path>`                        | asset file                                                                                         |
| `GET scenes`, `GET\|PUT scenes/<name>`     | names / scene JSON (PUT writes stable pretty JSON; the watcher echo is ignored)                    |
| `GET\|PUT comments`                        | `.ink/comments.json`, an array                                                                     |
| `POST handoffs`, `POST captures`           | body `{ id?, files: [{ name, text? \| base64? }] }` -> `{ id, dir }` (dir relative to the project) |
| `GET handoffs`, `GET captures`             | ids                                                                                                |
| `GET handoffs/<id>`, `captures/<id>`       | file names                                                                                         |
| `GET handoffs/<id>/<file>`, `captures/...` | the file                                                                                           |

Every path is checked: `..`, absolute paths, backslashes, NUL and empty segments
are rejected with 400; ids and scene names are single
`[A-Za-z0-9_][A-Za-z0-9_.-]*` segments.

Ids are sortable (`2026-10-08T12-03-11-abc`).

## HMR events (Vite websocket custom events; never a reload)

| Event             | Payload                 | When                                                                               |
| ----------------- | ----------------------- | ---------------------------------------------------------------------------------- |
| `ink:game`        | `{ revision, url, ms }` | a build succeeded                                                                  |
| `ink:diagnostics` | `{ diagnostics, ms }`   | a build or schema load failed                                                      |
| `ink:project`     | `ProjectInfo`           | schema or catalog changed (sent before the following `ink:game`/`ink:diagnostics`) |
| `ink:asset`       | `{ kind, path }`        | an asset's content changed                                                         |
| `ink:scene`       | `{ name, removed? }`    | a scene file changed externally                                                    |
| `ink:comments`    | `{}`                    | comments.json changed externally                                                   |

Builds are serialized and coalesced: a burst of saves yields one build. The
terminal shows `blot ✓ 23ms rev 4` or `file:line:col` with the source line.

## Client

```ts
import { createDevClient } from "@ink/dev/client";
const dev = createDevClient();
const project = await dev.project();
const schema = await dev.loadSchema(project);
const bytes = await dev.game(project.game!.revision); // then loadGame(bytes, schema)
const off = dev.on(
  "ink:game",
  (g) => /* fetch g.revision, swap the Game, keep the state */ {},
);
dev.on("ink:project", async (p) => {
  const next = await dev.loadSchema(p); /* migrateWorld, new catalog */
});
```

It also wraps scenes, comments, handoffs, captures and
`assetUrl(path, version)`. Without `import.meta.hot` (production) `on` returns a
no-op.

## CLI

`deno task ink <command> <project> ...`

- `dev [--port N] [--host]` dev server with `@vitejs/plugin-react` + `ink()` and
  `config.vite` merged.
- `gen` writes `game/schema.gen.blot` and `game/schema.gen.ts`. `check`
  compiles; diagnostics + nonzero exit on error.
- `test [--scenario name] [--update]` runs the project's recorded scenarios,
  state assertions and golden images in headless Chromium. `--update` writes new
  image baselines only when state assertions pass. See `docs/scenarios.md`.
- `run [--scene main] [--ticks 60] [--inputs inputs.json] [--out out.scene.json]`
  headless: compile, `start`, `step` N times (idle input, or recorded
  `InputModel[]`), print summary, resources and events (messages formatted from
  `schema.messages`, `{0}`/`{1}` = `a`/`b`).
- `capture [--scene name | --state file.scene.json | --handoff id] [--view game|editor|top|front|side|iso[,...]] [--size 1280x720] [--ticks N] [--out file.png] [--url http://...]`
  starts a dev server on a free port (or uses `--url`), launches headless
  Chromium with WebGPU (SwiftShader) flags, opens `/?ink-automation`, waits for
  `window.__ink.ready`, and writes `.ink/captures/<id>/<view>.png` plus
  `<view>.json` (options and returned info). Set `INK_CHROMIUM` to override the
  binary. Uncaught page errors fail the command before a capture is written.
- `comments` print open comments; `handoffs [--latest]` list ids or print the
  latest `handoff.md`.

## Automation contract (`window.__ink`, implemented by @ink/react)

Install it when `location.search` has `ink-automation`:

```ts
import type { InkAutomation } from "@ink/dev/automation";
interface InkAutomation {
  ready: Promise<void>; // game built and loaded, scene loaded, assets settled
  capture(
    o: { scene?; state?: SceneFile; handoff?; ticks?; view?; width?; height? },
  ): Promise<{ png: string /* data URL */; tick: number; view: unknown }>;
  run(
    o: { scene?; state?: SceneFile; ticks?: number; inputs?: InputModel[] },
  ): Promise<SceneFile>;
  state(): SceneFile;
}
```

Without an explicit scene, state or hand-off, automation uses the current live
world. Capturing does not stop play or change its tick. Recorded inputs run
through the session's timeline and can be rewound just like keyboard input.
