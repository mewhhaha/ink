# Ink

Reusable game systems for [Blot](https://github.com/mewhhaha/blot2). One source
library, imported as `ink/*`.

```blot
import * as math from "ink/math"

entry const orbit = fn (angle: F32) -> Array F32 => do:
  let p = math.Quat.rotate (math.axis_angle math.up angle) math.forward
  return #[p.x, p.y, p.z]
```

## Use it

Clone or vendor this repository and map your Blot compiler's `ink/` alias to
`lib/`. The Deno/Node entry point supplies that location:

```ts
import { libraryUrl } from "./vendor/ink/mod.ts";

const imports = { "ink/": libraryUrl }; // Pass to Blot's createCompiler options.
```

A native compiler needs files on disk. When the package is imported over HTTP,
use `installLibrary` to write its sources into a directory you choose:

```ts
import { installLibrary } from "./vendor/ink/mod.ts";

const imports = { "ink/": await installLibrary("./vendor/ink-sources") };
```

## Modules

| Import                                         | Provides                                                                                            |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `ink/math`                                     | Vectors, quaternions, colors, rays and rotations                                                    |
| `ink/arrays`, `ink/sort`                       | Array copies and stable sorting                                                                     |
| `ink/time`, `ink/transform`                    | Explicit timers, fixed steps, affine transforms and pose interpolation                              |
| `ink/random`, `ink/noise`                      | Explicit random state, seeded Perlin/value noise and fractal sums                                   |
| `ink/terrain`                                  | Heightfield sampling, normals, slopes, ground following and bounds                                  |
| `ink/tiles`                                    | Tile flags, queries and box movement through tile maps                                              |
| `ink/shapes`, `ink/contact`                    | Convex shapes, casts and contact manifolds                                                          |
| `ink/scene`                                    | Physics data types, scene construction and spatial queries                                          |
| `ink/spatial`                                  | Bounding-volume trees with immutable refitting                                                      |
| `ink/rigid`, `ink/character`, `ink/physics`    | Rigid bodies, character movement and deterministic simulation                                       |
| `ink/camera`, `ink/shadow`                     | Perspective/orthographic cameras, picking, frustum culling, stable shadow cascades                  |
| `ink/color`, `ink/lighting`, `ink/environment` | HDR transfer/exposure/tone curves, GGX lights/materials, sky and SH irradiance                      |
| `ink/particles`, `ink/motion`, `ink/animation` | Seeded particles, atlas sprites/billboards, easing/springs/shake, clips/blending/root motion/events |
| `ink/audio`                                    | Spatial gain, panning, Doppler, fades and scene occlusion                                           |
| `ink/navigation`, `ink/steering`               | Weighted A*, flow fields, crowd steering and field-of-view/line-of-sight                            |
| `ink/joints`, `ink/placement`, `ink/debug`     | Distance/spring/hinge/motor constraints, seeded placement, drawable diagnostic geometry             |

See [the API and compiler notes](docs/blot.md) and
[the package boundary](docs/architecture.md). [Examples](examples/orbit.blot)
construct library values directly.

## Optional presentation

Import adapters separately; the main entry point installs only Blot sources.

| Entry point               | Provides                                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `@ink/blot/gpu`           | HDR PBR, cascaded PCF shadows, horizon AO/denoising, diffuse/specular sky prefiltering, bloom, temporal AA, sprites and debug lines |
| `@ink/blot/ui`            | Unstyled native dialogs, menus, listboxes, sliders and controller navigation                                                        |
| `@ink/blot/input`         | Rebindable action contexts, keyboard/pointer/gamepad edges and device prompts                                                       |
| `@ink/blot/accessibility` | Reduced motion, UI scale, contrast and directional subtitles                                                                        |
| `@ink/blot/audio`         | Caller-owned WebAudio playback, gain/pan/rate/filter automation and disposal                                                        |

`deno task dev` opens the [material field](examples/graphics.html) and
[accessible controls](examples/browser-ui.html) at `http://localhost:8000`.

## Develop

Requires Deno and Zig 0.17.0 for the initial test compiler build. Browser checks
reuse Chromium or download Chrome for Testing on Linux x86_64; `INK_CHROME`
selects an installed executable on other platforms.

```sh
deno task check
deno task test
deno task test:fast
deno task test:affected lib/time.blot
deno task example
deno task bench
deno task bench:scene
deno task bench:game
deno task bench:gpu
deno task bench:compiler
deno task capture
```

`deno task setup` caches the pinned Blot compiler and standard library in
`.cache/blot/`. The [architecture notes](docs/architecture.md) describe
ownership and dependency boundaries. [API contracts](docs/blot.md) cover caller
state, packing and numerical conventions.

Use `test:fast` for local edits; `test:affected` follows transitive Blot
imports. `test:browser`, `test:stress` and `test:integration` isolate longer
checks; `test` runs everything. `toolchain` records versions and updates the
compiler pin.

Ordinary source edits skip archive packing in `test:affected`; run
`test:integration` before shipping.

Benchmarks retain numerical witnesses and report timings for compiler iteration,
scene updates, game systems and GPU passes in `.cache/bench-*.json`, with
warmups, sample spread and toolchain versions. GPU timings from SwiftShader
measure software rendering; run `bench:gpu 1920 1080 --hardware` on your target
machine for frame budgets. `capture` saves desktop/mobile graphics and controls
screenshots.

Tests execute the README and API examples, check source boundaries, pack the
actual distribution with `deno pack`, and exercise it from isolated HTTP and
Node consumers. Browser tests cover pixels, keyboard input, the accessibility
tree, offline audio and 100 setup/dispose cycles. Screen-reader speech requires
manual verification.

`deno publish --dry-run` validates the JSR package; `deno pack --dry-run` lists
the Node archive's generated JavaScript, declarations and shipped assets.
