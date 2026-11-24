# Package boundary

Ink is a Blot source library under `lib/`, imported through a caller's `ink/`
alias. It supplies reusable calculations, simulation, typed component pools,
scheduling, codecs, persistence, input, presentation and headless editing tools.
Core modules depend only on Ink and Blot's standard library. Applications own
assets, vocabulary, configuration, loops and storage lifetime. Pen is an
optional host, not part of the core library.

## Named owners and explicit copies

Each mutable pool has a separately named owner. Access records alias existing
owners for a call; they do not allocate a world or preserve an earlier version.
Use `#[...]` for all array literals and choose `Array`, `GrowArray` or
`ResizeArray` in the type. Fixed arrays allow element writes, growing arrays
allow append, and resizing arrays additionally allow shortening. Lists use
`[...]` and have explicit copy operations.

Rows contain scalars, fixed records, tagged data or spans into separate payload
pools. Long-lived rows use stable IDs and `{start, count}` spans. They cannot
contain owning nested arrays. A `&[T]` view captures a range in an existing owner;
it does not copy its elements or extend its lifetime. A `&T` reference names a
place, and a `^T` link retains checked owner identity. Neither is a snapshot.

Copying is an operation. An independent checkpoint supplies a destination pool
and, for payload spans, a policy that copies the corresponding payloads too.
Assigning an access record or a descriptor keeps its aliases. Replacements and
restores invalidate transient caches explicitly; there is no reference counting,
copy-on-write world or implicit simulation rollback in the target runtime.

## Collections and simulation

ECS state consists of a live-entity pool, separate typed component pools and
separate revision metadata. Entity IDs increase monotonically within an epoch.
A payload write changes its payload revision; adding or removing membership
changes the structural revision. The application's static schema clears its
registered columns on despawn and supplies previous-state copies when needed.
Query keys, selected IDs and build metadata belong to the caller. Structural
commands commit at explicit boundaries; no provider or observer runs hidden
inside a write.

Maps and sets use insertion-ordered flat rows plus independent hash buckets.
Callers supply compile-known hash and equality policies. Edits mutate these
owners; retaining an earlier map requires an explicit copy. Messages and
journals use bounded data pools with explicit reader cursors and reset signals.
Data job queues remain ordinary owned state.

Scene geometry has independent point, plane, ring, index, height and source-plane
pools. Persistent proxy rows retain spans into those pools. Scene updates receive
explicit dirty indices and overwrite reusable geometry where its extent is
unchanged. Spatial indexes refit caller-owned storage. Prepared physics retains
explicit geometry, lineage and revision identities; it does not retain a whole
world. Numerical, collision-order and deterministic gameplay rules remain part
of the library's behavior contracts.

## Static application stages and frame lifetime

An application composes known reset, start, normalization, checkpoint, input,
update, render and settle functions. Each receives explicit access to its state.
Policies and callbacks are known at compilation; runtime function registries,
general effect providers and language tasks are outside this profile.

A frame declares its output and payload pools locally, binds them into an
invocation access record, runs the stages and encodes the result before those
owners close. Draws, UI nodes and text may borrow these frame pools. Only copied
numeric packet data crosses the host boundary. Persistent render caches instead
keep stored rows, spans and separate payload owners, copying their presentation
into a frame when needed. Retained rendering keeps stable instance IDs and emits
explicit changes; dirty UI preparation retains its topology and revision logic.

Saves encode named sections into a numeric payload owner. Decode and restore
write caller-owned state and then normalize it. Snapshot, restore and replay are
explicit operations. A renderer may reject its transaction without undoing the
simulation step; session protocol version 2 distinguishes these outcomes so a
retry does not advance simulation twice.

## Hosts, workers and tools

`lib/pen/` translates Ink data into Pen's generated wire format. Pen's generator
and runtime import no Ink or game modules. Pen owns compilation, transport,
platform services, GPU resources and audio playback. Five core WGSL shaders have
host-neutral binding contracts in [shaders.md](shaders.md).

The sky's light is calculated here and consumed there: each frame the adapter
projects `graphics.sky` onto nine spherical-harmonic terms (`environment`,
`graphics.ambient`) and sends them with a reflection tint in the render packet's
sky. Pen only evaluates them and prefilters its own cube map of the same
gradient; a later per-position source (an irradiance probe grid) replaces that
evaluation inside Pen's `ambient_light(world, normal)` without any change here
beyond the data it would send.

The sun's shadow cascades follow the same split: Ink fits them and Pen draws and
validates what it is given. The application owns the camera, the light and how
far shadows reach, and the fit is calculation, so it belongs here (`ink/shadow`,
composed by `graphics.shadow`) and a host needs no camera or light policy of its
own. Each frame the adapter sends the shadow settings in the render packet's
`shadow` (the light's view, the map size `texels`, the PCF/PCSS `filter`, the
PCSS sun `softness`, the contact-shadow march `contact` steps and
`contact_length`, and the allowance `local` of shadow-casting point and spot
lights with their `local_texels`) and, in the new `cascades` section, up to four
windows, nearest first: an orthographic `projection` in the shared light view
with its depth range, its world-unit `texel` and the camera depth `far` where its
slice ends. Lights carry `shadow` and a stable `id`, which breaks ties between
equally near casters and names a light's map between frames.

The fit is stable by construction. A slice of the camera's view is bounded by its
smallest sphere, rounded up to a sixteenth and enlarged so that snapping the
window's centre to whole texels of the light's view keeps the sphere inside.
Radius and texel depend only on the lens and the splits, never on the camera's
pose, so a window only ever moves by whole texels and shadow edges do not
shimmer as the camera moves or turns. The frame's `shadow` settings
(`render.ShadowSettings`: reach, softness, contact length) are the game's; the
player's one shadow preference, the map size, picks a tier through
`graphics.tier`: off; 1024 low (two cascades, PCF); 2048 medium (three, PCSS, 12
contact steps, two local casters at 512); 4096 high (four, PCSS, 20 steps, four
casters at 1024). A frame whose camera or light cannot be fitted sends no
shadows.

Exposure and grading split the same way. The game states the look and the host
shows it: each frame the adapter sends `render.Exposure` (a fixed exposure in
stops, or auto exposure with its compensation, limits, brighten and darken
speeds, percentiles, centre weighting, histogram range and middle grey) and
`color.Grade` (white balance, exposure offset, contrast about a pivot, ASC CDL
lift, gamma and gain, saturation, vibrance, up to two blended look-up tables
named by material, a vignette) in the render packet's `exposure` and `grade`.
Pen meters the scene on the GPU (a log2 luminance histogram, a trimmed average,
an exponential adaptation that keeps the exposure in GPU memory and never reads
it back) and grades in its present pass, in light and a log encoding of it
before tone mapping, which serves SDR and HDR displays alike. Blot holds the
exact formulas (`color.grade`, `color.lut_lookup`, `color.trimmed_average`,
`color.adapt`) for the game, and the tests hold Pen's WGSL to them. The adapter
supplies what only it knows: `dt`, the game's seconds since the last frame (none
while paused, which holds the exposure), and a `cut` for the first frame after a
restore (`app.invalidate`), so a rewind does not show an earlier moment with the
exposure of the one it replaced. A game's brightness option is
`Exposure.compensation`; no player preference lane is added.

Fog splits the same way. The game states the medium: `render.Fog` (a mist whose
density falls off with height, cleared inside a radius, with its albedo,
anisotropy, the scales of the sun's and the ambient's light, a 3D noise and the
`drift` the game has carried it by) and up to 32 `render.FogVolume` boxes and
ellipsoids that add to it. The player's `volumetrics` preference (off, low,
high) caps the scene's own tier. Pen builds a froxel grid of the medium aligned
with the camera, lights it with the sun's cascades, the clustered lights and the
ambient light, integrates it front to back and applies it where the scene is
drawn; past the grid's reach, or with the tier off, the mist is analytic.
`ink/volumetrics` holds the exact formulas (the tiers' grids, the exponential
depth slicing, the medium at a point, the phase function, a froxel's source,
the column integral and the temporal blend), `ink/noise` the 3D value noise the
mist is varied by, and the tests hold Pen's WGSL to them and to an independent
f64 reference. Time reaches the noise only as `drift`: the same drift draws the
same mist.

Surfaces split the same way. `lighting.Material` holds the base (colour,
metallic, roughness, `ior`, `specular`, `specular_color`) and `lighting.Surface` adds
the optional lobes: clear coat, Charlie sheen, anisotropy, transmission with
volume and a cheap subsurface. Their formulas live in Blot as scalar kernels
behind `surface_response` and `shade_surface` (the whole response to one light,
`brdf` exactly when no lobe is on) and the lobes alone (`coat_response`,
`coat_ibl`, `sheen_response`, `sheen_albedo`, `aniso_response`, `bent_normal`,
`aniso_reflection`, `subsurface_response`, `refract`, `transmission_ray`,
`volume_exit`, `volume_attenuation`, `transmission_level`, `transmit`), and
parallax occlusion mapping is `parallax_uv`, `parallax_shadow` and `parallax`
over any height function (`grid_height` reads a texture's red channel). Pen's
WGSL surface library follows these formulas and its tests compare it with them
and with an independent f64 reference; `tools/native/src/surface.rs` is Ink's.
The exact rules (rounding, clamps, the sheen table) are in the Surface lobes
section of [blot.md](blot.md). The core `shaders/mesh.wgsl` keeps its
glTF-default `f0` and is unchanged.

Pen worker jobs exchange copied numeric buffers with isolated guests. Prepared
worker sessions retain explicitly revisioned contexts and join ordered results.
They do not share mutable application owners. Language-level task captures and
suspended task storage are removed from the target profile. Ordinary Foreign
calls and host suspension keep their invocation alive until settlement.

Tests and tools stay outside the source package. Run `pen test-blot` for Blot and
native reference witnesses, and `pen tool ink -- bench` for measured workloads.
GPU checks run headlessly. Generators own their outputs: change the model or
template, then regenerate. Consumers can export the library, shaders, examples,
documentation and content inventory with `pen tool ink -- pack DIR`.

The protocol fixtures in `tests/fixtures/pen/` come from `pen codegen --project
tests/fixtures`. Pen's generator does not write `provenance.json`; update it by
hand after regenerating: `pen_base_commit` is the Pen commit used, `schema_sha256`
is the plain SHA-256 of Pen's `protocol/schema.json`, `generator_sha256` is the
SHA-256 over the sorted `crates/pen-codegen/src/*.{rs,blot}` files each hashed as
basename, a NUL byte and contents, and `files` has the SHA-256 of each fixture.
A Rust test checks the fixtures' hashes; the other hashes are only as fresh as
that update.
