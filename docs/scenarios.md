# Recorded scenarios

Each example has `scenarios/*.scenario.json` and reviewed PNG baselines. Run
them without opening an editor:

```sh
deno task ink test examples/feel
deno task ink test examples/hammer --scenario walkthrough
```

The command opens headless Chromium with SwiftShader, plays recorded inputs
through the same session as the editor, checks state and compares captures. A
failure exits nonzero and writes `result.json`, actual frames and amplified
image differences under `.ink/scenario-results/<name>/`. Set `INK_CHROMIUM` to
override the browser executable. CI runs every example and uploads this
evidence.

```json
{
  "ink": 1,
  "name": "Jump",
  "scene": "main",
  "steps": [
    { "ticks": 60 },
    { "ticks": 12, "keys": ["Space"] }
  ],
  "checkpoints": [{
    "tick": 72,
    "assertions": [{
      "entity": "Runner",
      "path": "components.transform.position.1",
      "op": "gt",
      "value": 1.5
    }],
    "image": {
      "golden": "images/jump-72.png",
      "view": "game",
      "width": 320,
      "height": 180,
      "tolerance": 1
    }
  }]
}
```

`steps` holds keys for a fixed number of ticks. Press/release edges follow the
segment boundaries. Alternatively, `inputs` is an array of complete `InputModel`
records or a path to such an array relative to the project. Hammer uses its
recorded walkthrough this way. An explicit `state` can replace `scene`.

Assertions address the world unless `entity` specifies an id or name. Dot paths
can index arrays. Operators are `eq` (default), `near` (absolute tolerance,
default `0.0001`), `gt`, `gte`, `lt`, and `lte`. Missing entities or fields
fail. Checkpoint ticks are absolute world ticks; the recording must reach them.

Image paths are relative to `scenarios/`. Comparisons use mean absolute RGB
error in 8-bit levels; the default tolerance is 1, allowing small GPU
differences. Image dimensions must match. Captures are still frames, with stable
exposure and noise. Recreate baselines deliberately with `--update`; a scenario
whose state assertions fail cannot update its baselines.

The examples' **Run test** control runs the same files in the live editor. A
failure pauses at its first failing checkpoint. Select the red timeline marker
to inspect all assertions from that tick, the actual frame and a difference
image amplified four times. The recording remains available for scrubbing.
`deno task test:scenarios` deliberately disables jumping in the Feel Lab and
verifies this workflow with real browser interaction.
