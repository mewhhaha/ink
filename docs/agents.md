# Working with Ink as an agent

Ink is built so that a person can point at something in a running game and a
coding agent can see exactly that, change the code, and check the result —
without screenshots pasted into chat or "it does something weird when I jump".

## Work in the open editor

Start `deno task ink dev <project>` and open its browser editor. Connect an MCP
client to `http://127.0.0.1:<port>/__ink/mcp`. This is a stateless
[Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
endpoint supporting protocol versions `2025-11-25` and `2025-06-18`, with JSON
responses and no SSE stream. `initialize` and `tools/list` describe the tools.
Every ordinary editor registers automatically; no automation URL is needed.

The same commands are available over HTTP:

```sh
curl http://127.0.0.1:5173/__ink/live/sessions
curl http://127.0.0.1:5173/__ink/live/call \
  -H 'Content-Type: application/json' \
  -d '{"session":"<browser-id>","method":"comments","params":{"assignee":"agent"}}'
```

MCP tools use the prefix `ink_`; HTTP methods use the names below. With one
browser, `session` can be omitted. With several browsers, supply its id: an
ambiguous command fails without changing an editor. Commands run sequentially in
the selected browser. A disconnected browser fails pending requests; a timeout
reports that the state needs inspection before retrying a mutation.

| Method     | Use                                                                                                                                                                                           |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions` | List connected editors.                                                                                                                                                                       |
| `world`    | Read the current scene-shaped world, selection, mode, revision, diagnostics and mounted views.                                                                                                |
| `edit`     | Change `entity` + `component`, or `resource`, with partial `values`. Unknown fields fail; one call is one undo step. Optional `tick` rejects a stale edit.                                    |
| `play`     | `action`: `play`, `pause`, `stop`, `restart`, `undo`, `redo`, or `seek` with a `tick`.                                                                                                        |
| `step`     | Advance `ticks` or an `inputs` recording, leaving play paused.                                                                                                                                |
| `capture`  | Capture a mounted `view` id, or a standard game/iso/top/front/side view. Returns PNG, tick and a saved capture path.                                                                          |
| `comments` | Read active threads; filter by `assignee` or `status`, including `all`.                                                                                                                       |
| `comment`  | `action`: `add`, `update`, or `reply`; use `id` for an existing thread.                                                                                                                       |
| `handoff`  | `action`: `create` with a note, `open` a saved state, or `replay` the recorded inputs of an `id`.                                                                                             |
| `profile`  | Frame metrics (guest step, decode, extraction, render CPU, GPU, frame interval: last, median, p95, max) and the stages of recent save-to-pixels traces, each with the file that triggered it. |
| `source`   | Read a project source `path`; replace it using `text` and the `expectedHash` returned by reading. The editor hot reloads the change.                                                          |

For a reported issue:

1. Read the comment queue and assign a thread with `comment`,
   `{ action: "update", id, assignee: "agent", status: "in_progress" }`.
2. Use its `handoff` id with `handoff`, `{ action: "replay", id }`. Replay
   restores the post-start keyframe without calling the game's start entry
   again, and records the replay into the visible timeline.
3. Capture the named view. Read and edit the relevant source with its hash; poll
   `world.status` for the new ready revision or build diagnostics.
4. Replay again with the new code and capture the result. Reply with proof:
   `{ action: "reply", id, text, captures: [{ label: "before", path, tick, view },
   { label: "after", path, tick, view }] }`.
5. Set the thread's status to `resolved`. Replies and status changes persist
   before the API acknowledges them and appear immediately in the comment queue.

The toolbar's **Comments** button opens that queue in every editor. Threads have
assignees and `open`, `in_progress`, `blocked`, and `resolved` statuses. The
timeline's **Comment range** control saves a replay of the selected ticks;
compiler errors offer **Comment on diagnostic** with the source location.
Replies can attach before/after captures directly from the editor. Source writes
cover existing project `.blot`, `.ts`, `.tsx`, `.css` and `.json` files,
excluding hidden and generated files. Browser requests must come from the dev
server's origin. Keep the development server local to the workspace.

`deno task test:live` exercises this workflow against a disposable copy of Feel
Lab: it breaks jumping, reports and reproduces the issue, fixes code over MCP,
checks the live rebuild, attaches before/after frames, and clears a queue of
gameplay, timeline and diagnostic comments. It also checks session selection,
stale edits, and comment persistence, and saves `tmp/live-agent-workflow.png`.

## What the person gives you

Everything lands in `<project>/.ink/` (gitignored):

| Path                             | What it is                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------- |
| `handoffs/<id>/handoff.md`       | Start here. The note, a summary table, screenshots, selected entities, comments, console, errors. |
| `handoffs/<id>/state.scene.json` | The world at that moment, as a scene file.                                                        |
| `handoffs/<id>/replay.json`      | When playing: a keyframe plus every input since, to reproduce the last seconds exactly.           |
| `handoffs/<id>/*.png`            | Screenshots of the views that were on screen.                                                     |
| `comments.json`                  | Comments pinned to entities or points, with the camera they were made from and a screenshot path. |
| `captures/<id>/`                 | Screenshots taken by comments and by `ink capture`.                                               |

A comment's `anchor.entity` is the entity id; `anchor.local` is the pin in that
entity's local space; `anchor.view` is the camera pose. `anchor.range` stores
inclusive `from`/`to` ticks; `anchor.code` stores a file, line and optional
column. When the editor is closed, to answer a comment, add an entry to its
`replies` (`{ "author": "agent", "text": "...",
"created": "<ISO time>" }`) and
set `"status": "resolved"` when done; the editor reloads `comments.json` live.

## Seeing the game

```sh
# Render a scene, a state file or a hand-off from known views.
deno task ink capture examples/godot --view game,top,iso
deno task ink capture examples/godot --handoff <id> --view handoff,game
deno task ink capture examples/godot --state path/to/state.scene.json --ticks 120 --view game
```

Views: `game` (the active camera entity), `editor` (the saved editor camera),
`top`, `front`, `side` (orthographic, framed to the scene), `iso`, and `handoff`
(the camera the hand-off was made from). Output paths are printed; read the
PNGs. Same state + same view = same picture: captures render as stills (no
animated grain, exposure converged), bit for bit on a hardware GPU; under
software rendering a few pixels may differ by one level. Add `--quality high`
for ambient occlusion, bloom and finer shadows (slower without a GPU).

`deno task test:render` runs the renderer's capture, resize and
resource-lifetime regressions in Chromium with SwiftShader and saves frames to
`tmp/render-lifecycle-*.png`. Failed pixel comparisons also save both frames.
Add `--hardware --headed` to check in a desktop Chromium window using a real
GPU; the script prints the adapter and rejects software fallback in this mode.
If a sandboxed task cannot access the GPU, use the approved direct command
`deno run -A scripts/render-smoke.ts --hardware --headed`. This passed on the
RTX 4080 SUPER with NVIDIA WebGPU and no fallback on 2026-10-08.
`deno test -A --unstable-webgpu packages/render/lifecycle_test.ts` runs the same
checks on Deno's available GPU adapter. A missing browser adapter fails the
Chromium check; ordinary `deno task test` skips GPU tests when WebGPU is absent.

## Checking logic without a browser

```sh
deno task ink check examples/godot                       # compile; diagnostics with file:line:col
deno task ink run examples/godot --ticks 600             # start + 600 idle steps; prints resources and events
deno task ink run examples/godot --state <file> --ticks 60 --out after.scene.json
deno task ink run examples/godot --inputs inputs.json    # an array of InputModel, one per step
```

Steps are pure, so a run from the same state and inputs always gives the same
result. `replay.json`'s `inputs` can be written to a file and passed to
`--inputs` together with its `keyframe` as `--state` to replay what the person
did.

## Changing things

- Game code: `game/*.blot`. Read `docs/blot.md` first; the generated
  `game/schema.gen.blot` shows the exact types (`deno task ink gen <project>`
  writes it).
- Data shape: `schema.ts`. Fields are matched by name when worlds migrate, so
  adding, removing or reordering fields keeps scenes and running games intact.
- Scenes: `scenes/*.scene.json` are readable JSON (asset paths, field names).
  Editing one while the editor is open applies it as an undoable change.
- The editor UI: `src/*.tsx`, ordinary React over `@ink/react`.

If the person has the editor open, all of these reload in place while they
watch.
