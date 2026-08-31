# Ink

Ink is a foundation for focused game-development environments. Deterministic
game rules, state, scene choices, camera and light intent, audio cues, semantic
UI, and outcomes run in Blot WebAssembly guests. TypeScript compiles editor
documents, loads content-addressed assets, normalizes input, applies typed host
effects, and presents the result through one WebGPU renderer.

The workspace contains seven editor-owned games and two capability demos:

| Application        | Authored proof                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| `adventure-dev`    | Bind the oak gate, take the key, unlock the gate, and enter the ray-traced exit room.           |
| `visual-novel-dev` | Add a beat, rebuild, and reach both authored endings.                                           |
| `platformer-dev`   | Move the exit, rebuild, and jump to it with browser/headless replay parity.                     |
| `roleplaying-dev`  | Add ruins loot, follow the authored timeline, defeat the sentinel, and reach the shrine.        |
| `shooter-dev`      | Add a reinforcement, expend authored ammunition, defeat both enemies, and clear the arena.      |
| `strategy-dev`     | Add a barracks, train scouts, follow the authored route, and destroy the opposing headquarters. |
| `vehicle-dev`      | Append a checkpoint, reject an early finish, and complete the ordered course.                   |
| `lighting-dev`     | Compare raster and portable WebGPU path tracing in Cornell and Fog scenes.                      |
| `shrubbery-dev`    | Rebuild a retained Blot recipe unit and render deterministic voxel shrubbery.                   |

Capability demos cannot promote a core export to stable. Stable core contracts
must be exercised by an editor game.

## Run an application

Install Deno and pnpm 10, keep the authoritative Blot checkout at `../blot`,
then install the workspace:

```sh
pnpm install
```

Start any focused development application:

```sh
pnpm dev:adventure
pnpm dev:visual-novel
pnpm dev:platformer
pnpm dev:roleplaying
pnpm dev:shooter
pnpm dev:strategy
pnpm dev:vehicle
pnpm dev:lighting
pnpm dev:shrubbery
```

The browser renderer requires a non-fallback WebGPU adapter. On Linux,
`chrome://gpu` should report hardware-accelerated WebGPU. The applications fail
with an explicit diagnostic when no suitable adapter is available.

## Architecture

Source dependencies point toward the more general layer:

```text
core packages <- specialized editor <- development application
```

Core packages own game-neutral contracts. Editors own immutable genre documents,
commands, validation, serialization, presets, and focused React workspaces.
Applications own their Blot game, editor-document compiler, assets, host
adapters, and presentation composition. A free debug camera is a
development-only host override; it never enters deterministic game state.

`@ink/rendering` is the only renderer. It owns the WebGPU device, surface,
resources, encoding, submission, raster and compute passes, post-processing,
picking, and device-loss cleanup. `@ink/ray-tracing` owns device-neutral scene
packing, the CPU correctness oracle, accumulation rules, and composed WGSL.

See [the architecture guide](docs/architecture.md) for the runtime, proof, and
public-surface contracts.

## Executable proof

Every application has a version-2 `scenario.json`. An editor-game scenario names
exactly one editor, a real edit and outcome, headless and browser commands, and
the package subpaths its assertions exercise. Each command writes an atomic
assertion report through `INK_SCENARIO_REPORT`.

The workspace checker resolves production imports through package export maps,
runs both scenario commands, reconciles their assertion reports, and rejects:

- a stable core export without editor-game proof;
- a claimed export that production code does not reach;
- an experimental export outside `src/experimental`;
- a stable source import of an experimental module; or
- an editor with zero or multiple application owners.

`architecture/proof-report.json` is generated from the same manifests and export
maps so the public surface can be reviewed without trusting a handwritten
package list.

## Verification

```sh
pnpm check
pnpm test
pnpm build
pnpm test:browser
pnpm verify
```

`check` includes Ink formatting and linting, package type checks, executable
scenario proof, both local Blot compiler profiles, Blot's authoritative checks
and tests, and the ABI fixture. `test:browser` runs all nine applications
sequentially on ephemeral ports. `verify` runs all four gates and rejects any
change to Ink or the configured Blot repository contents, even when either
worktree was already dirty.

The production ray evidence is retained for direct inspection:

- `artifacts/lighting/cornell-path-traced.png`
- `artifacts/lighting/fog-path-traced.png`
- `artifacts/adventure/gate-room-path-traced.png`
