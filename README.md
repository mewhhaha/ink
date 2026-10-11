# Ink

Reusable math, geometry and physics for
[Blot](https://github.com/mewhhaha/blot2). One source library, imported as
`ink/*`.

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

Blot supplies the compiler, standard library and WebAssembly guest API. Your
application owns its state, input, assets and presentation. Ink functions take
ordinary Blot values; your application chooses its own host boundary.

## Modules

| Import                                      | Provides                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| `ink/math`                                  | Vectors, quaternions, colors, rays and rotations                       |
| `ink/arrays`, `ink/sort`                    | Array copies and stable sorting                                        |
| `ink/time`, `ink/transform`                 | Explicit timers, fixed steps, affine transforms and pose interpolation |
| `ink/random`, `ink/noise`                   | Explicit random state, seeded Perlin/value noise and fractal sums      |
| `ink/terrain`                               | Heightfield sampling, normals, slopes, ground following and bounds     |
| `ink/tiles`                                 | Tile flags, queries and box movement through tile maps                 |
| `ink/shapes`, `ink/contact`                 | Convex shapes, casts and contact manifolds                             |
| `ink/scene`                                 | Physics data types, scene construction and spatial queries             |
| `ink/spatial`                               | Bounding-volume trees with immutable refitting                         |
| `ink/rigid`, `ink/character`, `ink/physics` | Rigid bodies, character movement and deterministic simulation          |

See [the API and compiler notes](docs/blot.md) and
[the package boundary](docs/architecture.md). [Examples](examples/orbit.blot)
construct library values directly.

## Develop

Requires Deno and Zig 0.17.0 for the initial test compiler build.

```sh
deno task check
deno task test
deno task example
deno task bench
deno task bench:scene
```

The tools use pinned upstream Blot revision `86a527b`. `deno task setup`
downloads and builds it once into `.cache/blot/`; repeated runs reuse the binary
and standard library. A sibling Blot checkout is unnecessary. The configured
native Blot `0.2.0` package has not been published, so the tooling uses upstream
source until that package is available. These test tools are excluded from Ink's
distribution.

`bench` reports compiler startup, cold/incremental builds and terrain query
cost. `bench:scene` measures scene construction, repeated queries and geometry
reuse at 100, 1,000 and 10,000 static colliders plus four movers. `test`
includes an isolated consumer that installs the distribution over HTTP, then
compiles and executes all four examples without this repository's config.

Scene queries use a bounding-volume tree. `scene.update` takes the changed
source indices, reuses other shapes and refits their bounds. Contact caches
retain full-width U32 ids. Finite static terrain participates in the same
queries and simulation as boxes, spheres, capsules and convex brushes.

Measured scene construction plus 544 mixed hit/miss queries, in milliseconds:

| Static colliders | Geometry       | Before | After |
| ---------------- | -------------- | -----: | ----: |
| 100              | Boxes          |    4.3 |   3.9 |
| 100              | Convex brushes |    7.1 |   6.4 |
| 1,000            | Boxes          |   19.2 |   5.9 |
| 1,000            | Convex brushes |   49.9 |  36.0 |
| 10,000           | Boxes          |  637.6 |  43.4 |
| 10,000           | Convex brushes |  949.0 | 362.5 |

These are three-round warm medians on Linux x86_64, Deno 2.9.7, with four
movers. The index adds construction work; reuse it across steps. Paired query
and update estimates subtract separate build calls and retain measurement noise,
including negative estimates. Use the full workload comparison above; these are
synthetic measurements, not frame-budget guarantees. The benchmark writes its
raw report to `.cache/scene-after.json`.

`deno publish --dry-run` checks the package contents without publishing it.
