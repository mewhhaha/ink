# Working with Ink as an agent

Ink is built so that a person can point at something in a running game and a
coding agent can see exactly that, change the code, and check the result —
without screenshots pasted into chat or "it does something weird when I jump".

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
entity's local space; `anchor.view` is the camera pose. To answer a comment, add
an entry to its `replies`
(`{ "author": "agent", "text": "...",
"created": "<ISO time>" }`) and set
`"status": "resolved"` when done; the editor reloads `comments.json` live.

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
