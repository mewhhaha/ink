# Core shaders

Five standalone WGSL sources accompany the Squid modules. Copy or read them from
`shaders/` in the checkout or package. Applications create their own GPU
resources, bind groups and pipelines. Each file has a `vertex` entry point; all
except `shadow.wgsl` also have a `fragment` entry point.

Inputs must be finite. Matrices use column-major F32 storage, column vectors and
WebGPU depth [0,1], matching `ink/camera`. Colours and lighting are linear; use
an sRGB atlas format to decode authored sRGB textures. HDR outputs suit
`rgba16float`. Mesh and sprite RGB outputs clamp to that format's finite range.

## Mesh

[mesh.wgsl](../shaders/mesh.wgsl) transforms a mesh and shades one directional
light with the GGX model from `ink/render/lighting`, plus material emission. It writes
one linear HDR colour attachment. Vertex attributes are location 0 `float32x3`
position and location 1 `float32x3` normal; interleaved, their offsets are 0 and
12 bytes with a 24-byte stride.

Group 0, binding 0 is the 112-byte frame uniform:

| Offset | Field            | Storage | Meaning                                    |
| ------ | ---------------- | ------- | ------------------------------------------ |
| 0      | `viewProjection` | mat4x4f | World to clip                              |
| 64     | `eye`            | vec4f   | World-space eye in xyz                     |
| 80     | `lightDirection` | vec4f   | World-space direction light travels in xyz |
| 96     | `lightRadiance`  | vec4f   | Incoming linear RGB radiance               |

Group 1, binding 0 is the 176-byte object uniform:

| Offset | Field          | Storage | Meaning                                    |
| ------ | -------------- | ------- | ------------------------------------------ |
| 0      | `model`        | mat4x4f | Affine object to world                     |
| 64     | `normalMatrix` | mat4x4f | Inverse transpose of model; xyz block used |
| 128    | `base`         | vec4f   | Linear RGB reflectance and output alpha    |
| 144    | `material`     | vec4f   | Metallic in x, perceptual roughness in y   |
| 160    | `emission`     | vec4f   | Linear RGB emitted radiance                |

Unused lanes are ignored. Reflectance should be in [0,1], radiance nonnegative.
Metallic clamps to [0,1] and roughness to [0.04,1]. Zero normal, eye delta or
light direction contributes no direct lighting. Supply a nonsingular model and
its normal matrix, including for nonuniform scale or shear. Applications choose
depth, culling and transparency policies.

## Sprites and debug lines

[sprite.wgsl](../shaders/sprite.wgsl) accepts the `ink/particles.vertices`
triangle-list stream: xyz, uv, rgba. Locations 0, 1 and 2 use `float32x3`,
`float32x2` and `float32x4`, at byte offsets 0, 12 and 20; stride is 36 bytes.
Group 0 binds a 64-byte view-projection matrix at 0, a filterable 2D atlas at 1
and a sampler at 2. Output is straight-alpha tinted texture colour; alpha below
0.001 discards the fragment. For ordinary transparency, use additive blend
operations with colour factors `src-alpha` / `one-minus-src-alpha` and alpha
factors `one` / `one-minus-src-alpha`.

[debug.wgsl](../shaders/debug.wgsl) accepts `ink/debug.vertices`: xyz, rgba,
locations 0 and 1 using `float32x3` and `float32x4`, offsets 0 and 12, stride 28
bytes. Group 0, binding 0 is a 64-byte view-projection matrix. Use a `line-list`
pipeline; output is the supplied linear vertex colour.

## Shadow depth

[shadow.wgsl](../shaders/shadow.wgsl) writes transformed depth with no fragment
stage or colour attachment. Location 0 is `float32x3` position. Group 0, binding
0 is a 64-byte light view-projection matrix; group 1, binding 0 is a 64-byte
affine model matrix. Configure a depth attachment and comparison function;
shadow sampling, filtering and bias belong to the application.

## Display

[display.wgsl](../shaders/display.wgsl) draws a fullscreen triangle with
`draw(3)` and no vertex buffer. Group 0 binds exposure at 0 (F32 stops at byte
0; allocate 16 bytes), a filterable linear HDR 2D texture at 1 and a sampler at
2. UVs preserve the source's top-left orientation and allow resizing.

Input RGB clamps to [0,65504] and exposure to [-16,16] stops. The fitted display
curve matches `ink/color.tone` within this range; it is not the full ACES colour
pipeline. Output alpha is always one. The `encodeSRGB` pipeline constant
defaults to `true` for an ordinary unorm target. Set it to `false` for an sRGB
attachment, where hardware supplies the transfer function, or to retain linear
output. Apply the transfer function once.

`pen test-squid --filter shaders` compiles the sources, creates pipelines and checks
offscreen pixels using Rust/wgpu. It needs a WebGPU adapter; a Vulkan
software adapter suffices. The test tooling stays outside the package.
