# Multiplayer

Run `deno task ink dev examples/feel`, open the editor in two browsers, and
choose **Multiplayer → Join room** in both. The room name must match. The first
player supplies the scene snapshot and room settings; the second must have the
same build, schema, catalog and scene. Feel Lab opens `multiplayer.scene.json`:
player 1 is blue, player 2 is orange. Use A/D and Space. Its shared game camera
keeps both runners in view.

The room dialog offers rollback or lockstep and an optional simulated one-way
input delay. The default 100 ms is an explicit test setting. Turn it off for
ordinary play. The toolbar reports predicted ticks and corrections. Stop or
Leave room ends the connection for both clients. A peer disconnect leaves the
game paused with its corrected timeline available for rewind and hand-offs.
Code/schema replacement ends the room so different guests cannot silently keep
simulating together. Live world edits are refused during network play.

## Pure simulation

`@ink/core` exports a transport-independent `Rollback` engine and
`MultiplayerPlay`, a driver for the existing `Session`. The latter can follow
the caller's frame clock or use a timer independent of rendering. Each input
contains an id-sorted `players` array. Blot selects controls with:

```blot
let controls = s.player_input input runner.player
let jump = controls.actions.jump
```

Offline, `player_input` uses the ordinary controls. In a network step, a missing
owner gets idle controls. The top-level controls come from the lowest player id,
so legacy game logic sees the same input on every client. No client-specific
camera, selection or network statistics enter the world packet.

Inputs cross the wire as F32 packets, including viewport and pointer state. Tick
rate and time are canonical. Prediction holds the last known buttons and axes,
clearing press/release edges and pointer deltas. A late correction restores the
nearest keyframe (every eight ticks) and replays to the present. The default
history window is 240 ticks, and prediction stops after twelve unconfirmed ticks
until the slow peer catches up. Lockstep waits for every peer's actual input
before advancing.

Each confirmed state has an FNV-1a hash of its exact bytes. Early peer hashes
wait for local confirmation; different hashes end the room with the peer and
tick in the error. FNV is a desync check, not authentication. Audio and other
presentation events emit once when confirmed; replay never duplicates them.
Corrected inputs and keyframes replace the corresponding section of the ordinary
session timeline.

`NetworkChannel` is the transport boundary. The supplied Vite relay assigns two
player ids, checks build identity, and forwards only that socket's own inputs
and hashes. It validates packet bounds, cleans up delayed deliveries on
disconnect, and isolates rooms. It is a development server, without accounts,
matchmaking, cheat prevention or reconnect/resume. The core engine supports 2–16
peers for other transports.

## Verification

- `deno test -A packages/core/rollback_test.ts` compares separate Wasm guests
  against lockstep for 300 ticks under 100 ms delay with jitter, reversed
  delivery and duplicates. It checks byte equality, button edges, deterministic
  random state, keyframe snapshots, bounded memory, prediction limits and desync
  errors.
- `deno task test:multiplayer` drives keyboard input in two independent browser
  contexts through the real relay. It measures local input response, compares
  confirmed packets, jumps, disconnects a peer and rewinds the retained editor
  timeline to the same state. Screenshots and results are saved in `tmp/` and
  CI. The default check requires motion on the first local simulation step; pass
  `--timing` to also enforce a wall-clock response below 100 ms on the test
  machine.
