# @ink/noise

`@ink/noise` provides deterministic procedural fields for CPU generation and
matching WebGPU shaders. It owns sampling mathematics and baking; it does not
own terrain, materials, textures, renderer resources, or gameplay state.

## CPU sampling

Seeds and periods are constructed once at the trust boundary. Every public
sampler takes a named options object:

```ts
import { noise_period_2d, noise_seed } from "@ink/noise/domain.ts";
import { fbm_2d } from "@ink/noise/fractal.ts";
import { vec2 } from "@ink/math/vector.ts";

const height = fbm_2d({
  position: vec2(12.5, -3.25),
  seed: noise_seed(42),
  period: noise_period_2d(256, 256),
  octaves: 5,
  lacunarity: 2,
  gain: 0.5,
});
```

Value and gradient noise support 1D, 2D, and 3D. Cellular samples additionally
return nearest and second-nearest distances, their difference, the selected
feature position, and a stable cell identity. Euclidean, Manhattan, and
Chebyshev distance are explicit choices.

Fractal functions normalize by their amplitude sum. fBm is signed; turbulence
and ridged noise are nonnegative. Domain warp is available in 2D and 3D. Curl is
defined in 2D and 3D, where a curl field is dimensionally meaningful, and uses a
configurable finite-difference step.

## Periodic tiling

A period is measured in lattice cells. Passing a period makes the field repeat
at that displacement, including negative coordinates. Fractal lacunarity is a
positive integer, and each octave scales its lattice period with frequency. This
keeps fBm, turbulence, ridged fields, domain warp, and curl periodic rather than
merely making their first octave tile.

## Batch and bake layout

Batch sampling returns `Float32Array`. Texture and volume baking are row-major,
with x varying first, then y, then z. Channels are interleaved per texel or
voxel and restricted to one through four. A sample coordinate is exactly
`origin + index * step`; no implicit half-texel offset is applied.

## WGSL contract

`noise_wgsl_modules` exposes stable `hash`, `value`, `gradient`, `cellular`, and
`fractal` modules. `noise_wgsl_source()` concatenates them in dependency order.
The source includes 1D/2D/3D hashing, value, gradient, cellular-nearest, and fBm
functions plus 2D turbulence, ridged, domain-warp, and curl functions. Host code
must enforce the same constructor constraints as the CPU API before dispatch.

WGSL uses `f32`, while the CPU reference calculates in JavaScript `number` and
bakes to `f32`. Exact hash and lattice decisions must agree. Scalar field
comparisons use the fixture-specific `2e-6` tolerance. The literal fixtures in
`wgsl_parity_fixtures` can be uploaded to a device test; the headless
`verify_wgsl_parity_fixtures()` check detects CPU contract drift without
pretending that a GPU ran.
