# Writing Blot for Ink

Read `../blot2/compiler/guide.md` first; it is the language reference. These are
the things that matter most when writing Ink games, including compiler behaviour
found the hard way. Keep this list current.

## Shape of a game

- `game/main.blot` imports the generated module:
  `import * as s from "./schema.gen"`. It is regenerated from `schema.ts` on
  every schema change; never edit it.
- Ink's library is under the `ink/` alias: `ink/math` (Vec4, Quat, Color, Ray,
  `axis_angle`, `yaw_pitch`, `Quat.rotate`, `Ray.plane`, `approach`),
  `ink/input` (Button, Pointer), `ink/random`, `ink/packet`, `ink/noise`,
  `ink/terrain`, `ink/physics` (+ `ink/scene`, `ink/shapes`, `ink/contact`,
  `ink/rigid`, `ink/character`, `ink/sort`, `ink/arrays`).
- Export
  `entry const step = fn (lanes: Array F32) -> Array F32 => s.run update lanes`
  and optionally `entry const start` the same way. `update` has the type
  `s.Input -> s.World -> s.World` and may use `s.emit`, `s.random` and
  `s.random_range`.

## Idioms

- Update entities with `array.map` for pure per-entity systems, or `s.each` when
  the per-entity function uses effects.
- Component access: `let #Some t = entity.transform else: return entity`, then
  `entity.transform := #Some t` after changing `t`.
- Field paths rebind: `world.resources.score.value := self + 1`,
  `transform.position.y := self - 9.8 * input.dt`.
- New entities: `let e = s.blank`, set components
  (`e.mesh := #Some s.default_mesh`), then `let (id, world2) = s.spawn e world`.
- Names: `entity.name_id` is a host text symbol. Declare
  `names: { player: "Player" }` in the schema to generate `s.name_player`. Names
  remain text in scene files, and `name_id` survives steps and spawning.
- Events: `use s.emit (#s.Log { message: s.message_coin, a: 1.0, b: 0.0 })`.
- Particle bursts:
  `use s.emit (#s.Particles { emitter: id, position: at,
  count: 96, seed: input.tick })`.
  The referenced standard `emitter` supplies the effect's appearance; rate 0
  means burst-only. Its particles are GPU presentation reconstructed from the
  tick, including during rewind.
- Debug drawing:
  `use s.emit (#s.Line { start: a, end: b, color: math.rgb 1.0 0.2 0.2 })` draws
  in the editor views for that step (needs `standard.events`). Constructors from
  another module are qualified: `#s.Log`, `#s.Point`.
- Collision, rigid bodies, characters and queries: `ink/physics` with the
  generated `s.physics_step` / `s.physics_scene` (see `docs/physics.md`).
- Tile maps: `ink/tiles` (`grid`, `tile_at`, `flags_at`, `touches`, `slide`):
  build a `Grid` from a `tilemap` component's `width`, `height`, `cell`, `cells`
  and the generated `s.tileflags_<atlas>`, then
  `tiles.slide grid half
  drop pos vel dt` moves a box through solid tiles,
  onto one-way planks (unless `drop`), reporting `grounded`, `wall` and `head`.
  Flags: `tiles.solid`, `oneway`, `ladder`, `hazard`. See `docs/2d.md`.
- Noise: `ink/noise` (`perlin1`, `perlin2`, `perlin3`, `value2`, `fbm2`, `fbm3`,
  `at`), deterministic per seed — terrain, wind, wobble, shake.
- Terrain: `ink/terrain` (`make`, `height`, `normal`, `ground`, `slope`,
  `inside`, `stick`, `stand`, `range`): build a `Terrain` from a `terrain`
  component's `size`, `collision_cells`, `grid` and detail fields plus the
  entity's position, then ask for the ground height or normal at a world x/z or
  keep a character on the ground. See "Terrain" below.
- Effectful calls need `use`: `use roll <- s.random ()`. `let` and `:=` must be
  pure.

## Terrain

`ink/terrain` answers "where is the ground?" for the standard `terrain`
component. The heightmap itself never enters the world packet; the guest sees
the component's coarse `grid` (`collision_cells + 1` squared heights in metres,
`height_scale` applied, row by row from the -z edge) and the parameters of its
procedural detail. The ground height at a point is the bilinear height of the
grid plus `detail_amplitude * noise.fbm2` of the point, which is what the
renderer draws and `packages/geometry/terrain.ts` computes (the Blot and
TypeScript versions are compared in `packages/blot/terrain_test.ts` to 1e-3 m;
the noise agrees to 1e-6). Beyond the square the border value continues. The
terrain is centred on its entity and only its position counts, so keep it on a
root entity.

```blot
import * as terrain from "ink/terrain"

// Built once per step; every query below is a few array reads and the noise.
const find_ground = fn (world: s.World) => do:
  for e in world.entities:
    if let #Some c = e.terrain:
      if let #Some t = e.transform:
        return #Some (terrain.make t.position c.size c.collision_cells c.grid c.detail_amplitude c.detail_wavelength c.detail_octaves c.detail_seed)
  return #Nothing

const walk = fn (input: s.Input) => fn (ground: terrain.Terrain) => fn (entity: s.Entity) => do:
  let #Some body = entity.walker else:
    return entity
  let #Some t = entity.transform else:
    return entity
  body.velocity.y := self - body.gravity * input.dt
  let moved = t.position + body.velocity * input.dt
  // Standing on the ground, hold on to it down to 0.3 m below (walking down a slope).
  let reach = if body.grounded then 0.3 else 0.0
  let stood = terrain.stick ground moved 0.9 reach
  if stood.grounded && body.velocity.y < 0.0:
    body.velocity.y := 0.0
  t.position := stood.position
  body.grounded := stood.grounded
  entity.walker := #Some body
  entity.transform := #Some t
  return entity
```

(This is the game of the "game code reads a terrain component" test in
`packages/blot/terrain_test.ts`, which runs it.) All positions are world
positions; `height` is world y, so a terrain entity at y = 5 lifts the whole
ground by 5.

- `terrain.make` takes the entity's position, then the component's `size`,
  `collision_cells`, `grid`, `detail_amplitude`, `detail_wavelength`,
  `detail_octaves` and `detail_seed`. A `grid` that is not `(cells + 1)^2` long
  (the terrain tools have not filled it yet) is flat ground at the entity's
  height plus the detail, never a trap. The grid is decoded with the rest of the
  component every step (about 5 ns per lane: 0.1 ms at the default 128 cells,
  0.3 ms at 256), so keep `collision_cells` as small as the gameplay allows.
- `terrain.height t x z -> F32`, `terrain.ground t p -> Vec3` (`p` with y
  replaced by the ground), `terrain.above t p -> F32` (`p.y` minus the ground),
  `terrain.inside t x z -> Bool` (over the square).
- `terrain.normal t x z -> Vec3` (unit, `y` is the cosine of the slope angle),
  `terrain.gradient t x z -> Vec2` (rise per metre along x and z),
  `terrain.slope t x z -> F32` (rise over run: 0 flat, 1 at 45 degrees). They
  use central differences half a metre apart, the detail's scale; `normal_by`
  and `gradient_by` take the step first. A normal costs four heights.
- `terrain.stick t position lift reach -> Stand`, and `terrain.stand` for the
  same with no reach. `lift` is how far the body's origin sits above its lowest
  point. A body at or below the ground (or within `reach` above it) is put on
  top of it: `Stand { position, normal, grounded }`, with the ground's normal
  under it (up while airborne). The game applies gravity and velocity first and
  zeroes the vertical velocity when `grounded`; without `reach`, a body walking
  down a slope hops, because the ground drops faster than gravity pulls.
- `terrain.range t x0 z0 x1 z1 -> (low, high)`: the lowest and highest world y
  the ground can have over a rectangle, never an underestimate (grid samples
  under it, plus the detail's amplitude), for pruning.

Cost: a height is about 0.2 to 0.4 us with three octaves of detail on the
current compiler (1 us on the CI revision), so a step can afford thousands of
queries; with `detail_amplitude` 0 it is a bilinear read (~10 ns).

### As a static heightfield collider

The ground is the function y = h(x, z), so a physics world needs no mesh for it:
the `Terrain` built in the step is the shape, and `height`, `normal` and `range`
are enough for a character controller or a heightfield contact generator (what
`ink/physics` would do with it):

- Broadphase: take a body's world AABB and call `terrain.range` over its x/z
  extent; skip the body when its bottom is above `high` (plus the margin).
- Sphere (centre `c`, radius `r`): with `n = terrain.normal t c.x c.z`, the
  distance to the ground is `(c.y - terrain.height t c.x c.z) * n.y`;
  penetration is `r` minus that, the contact normal is `n` and the contact point
  is `c - n * (distance)`. Capsules do the same for the closest point on the
  segment (the lower end, or both ends); boxes and convex hulls test their
  support vertices (the lowest points, `terrain.above t v < 0`) and keep the
  deepest few as the manifold, with `n` taken at the vertex.
- A character controller is `terrain.stick` plus `n.y < cos max_slope` to refuse
  slopes that are too steep (slide along `gradient` instead of climbing).
- A fast body can pass through a ridge between two steps: march `height` along
  its motion with a step of at most half the smallest feature (the smaller of
  the cell size, `size / collision_cells`, and the finest octave,
  `detail_wavelength / 2^detail_octaves`) and bisect the crossing.
- The guest sees the coarse grid, not the full heightmap: a cliff finer than
  `size / collision_cells` is smoothed for gameplay, while the detail noise is
  exact. Set `collision_cells` for the finest edge gameplay must respect.

## Compiler notes (Blot2 as of 2026-10)

The two expression failures below are reproduced against Blot2 `6db786f` and
tracked in [blot2#8](https://github.com/mewhhaha/blot2/issues/8), with minimal
examples and passing workarounds.

CI builds published Blot2 `86a527b`. That revision predates `type Name = ...`
aliases and `list.concat`; use explicit tuple annotations and process lists in
sequence. All four example scenarios pass with this published revision and the
newer local compiler.

- A qualified module value cannot be projected: `s.defaults.transform` fails
  with `unknown_value`. Ink generates flat names (`s.default_transform`,
  `s.mesh_coin`, `s.message_jumped`) for that reason.
- `from x` written inline inside a nested array literal that also has a spread
  (`#[#[from n], ...rows]`) fails with `constant_expression`. Bind it first
  (`let n_f: F32 = from n`) or call `U32.to_f32` directly.
- No runtime strings. Text lives on the host; Blot refers to messages by id.
- U32 in packets is exact only below 2^24 (lanes are F32).
- Negative literals as arguments need parentheses: `F32.abs (-2.0)`.
- The prelude has `sin`, `cos`, `tan`, `sqrt`, `floor`, `ceil`, `min`, `max`,
  `clamp`, `lerp`, `smoothstep`, `wrap`, `lerp_angle`; no `atan2`/`asin`.
- Arrays are immutable values; `values[i] := x` makes a new version (in place
  when the compiler proves uniqueness, e.g. a local carried through a loop).
  Passing an array to a helper that updates it copies it.
- There is no `continue`; use `if` around the loop body.
- A `case` arm is one expression. To run several statements for a variant write
  `#Kind =>` followed by `do:` and an indented suite; a bare indented suite is a
  syntax error reported on the whole declaration. Patterns on constructors of
  another module are qualified too (`#s.Coins => ...`).
- A schema field cannot be called `data` (a Blot keyword; `ink gen` says so),
  which is why a tile map's ids are `cells`.
- Every component an entity has is decoded when the world enters `update` and
  encoded when it leaves, whether the game reads it or not: demand evaluation
  does not skip unread record fields. That costs about 5 ns per packet lane per
  step (20,000 entities of 45 lanes: 5 ms) before your systems run.
- A `for ever` loop keeps its carry across host calls (JSPI), but every fourth
  backedge traces the whole object graph and allocation after a collection is
  slower. Holding a 20,000-entity `World` there is cheaper on average while a
  fifth or fewer of the entities change per step, yet one step in four then
  costs 22 to 29 ms, and with every entity moving it is two to three times
  slower (`scripts/guest-loop-bench.ts`). Ink keeps `step` stateless and the
  host owns the packet.
- The generated `encode_result` writes the packet with `out[i] := x` on a local
  array inside `for` loops, which updates in place. Passing such an array to a
  helper that updates it copies the whole array; keep writes in the loop body.

### Build times, measured for hill 12

`scripts/compile-bench.ts` and `deno task test:iteration` (`docs/iteration.md`)
measure these; numbers are medians on a 16-core machine that other agents kept
at a load average of 20 to 40, with the newer local compiler and its restart
cache. Expect them to be a third to a half lower on a quiet machine.

- **blotc, incremental** (one number edited in `main.blot`, retained session):
  terrain 16 to 19 ms, tiles 20 to 30 ms, Feel 52 to 57, TrenchBroom 52 to 60,
  Hammer 60 to 78, Godot 62 to 76 ms. Cold, with the restart cache, 90 to 450
  ms. A comment-only edit or a schema default the game never reads produces the
  same Wasm bytes; Ink then skips the transfer and the swap.
- **It grows with the module, not with the edit.** Hammer padded with generated
  per-entity systems (`compile-bench.ts hammer --sizes=0,100,400`): 459 KB of
  Wasm 78 ms, 551 KB 110 ms, 827 KB 201 ms, for the same one-number edit. The
  backend `generate` phase is 48, 63 and 98 ms of those; the rest is outside the
  reported phases. "Under 100 ms on large games" needs the cost of an edit to
  follow the change; for upstream.
- **V8 compiles the new module lazily, on its first call, and that is now the
  largest single stage of a code reload.** Compile and instantiate take 1 to 15
  ms; the first `step` of a fresh module then takes 80 ms (tiles, 138 KB), 170
  (Feel), 250 to 300 (Godot, TrenchBroom, Hammer, 440 to 470 KB) because every
  function it reaches is compiled by Liftoff, about 0.6 ms per KB, 1.5 to 1.7
  MB/s. `--no-wasm-lazy-compilation` does not help (the same work is done up
  front, on several threads), and the compilation hints section is not honoured
  by Chromium 153. Godot's module has 357 functions and 32,467 locals; the
  largest function is 69 KB with 4,357 locals, the next 41 KB with 2,297. The
  schema codec alone is 118 KB of it (a main that only calls `s.run`), the rest
  is game logic and the physics glue. Ink runs one throwaway step of each new
  module in a worker (a `WebAssembly.Module` shares its compiled code with the
  page), so the page keeps running the old game meanwhile and the swapped-in
  module's first step takes 1 ms. That removes a 200 to 300 ms freeze, not the
  latency: smaller or fewer-local functions, per-function patching through a
  `call_indirect` table, or separately compiled library modules (`ink/physics`,
  the codec) that an edit does not touch would, and so would literal edits that
  patch the old Wasm (blot2's hill 6).
- Instantiating takes 0.2 ms and a swap with unchanged layout migrates nothing,
  so re-instantiating is not a cost worth "patching around"; the world already
  lives on the host.

### Found while writing the physics library

- **Updating an array in place needs a local array that never leaves the
  function.** Passing it to any other function (even `vec a i` to read three
  numbers), or starting from a parameter or a record field, makes every later
  write copy the whole array (a loop of 40,000 writes took 50 ms instead of
  0.2). Start with an explicit copy (`@array.generate n (fn i => a[i])`,
  `ink/arrays.copy`), read with inline `a[i]`, and keep read-only data in
  separate arrays that helpers may take.
- Small pure helpers over scalars (`turn q i x y z -> (x, y, z)`) are fine; a
  `Vec3` record per temporary costs ~50 ns in hot loops, so solver inner loops
  use scalar locals.
- A `do` statement cannot continue with `else if`; nest `if` inside `else:`.
- Only one spread per list literal: `[...a, ...b]` fails to parse. Keep a
  `List (Array F32)` and `array.flatten` it.
- Constructors of an imported type are qualified (`#shapes.Capsule`, also in
  patterns); `Name.fn` members need the module (`math.Quat.rotate`).
- A multi-line `case` cannot sit inside a record literal; bind it first.
- A function written without parameter types can still read nominal fields
  (`e.body`, `p.speed`) of whatever type it is used with.
- A single guest call that allocates heavily for hundreds of steps can trap with
  `unreachable` (the arena only resets between calls). Step the game once per
  call, as the host does.

### Found while writing the terrain library

- `of` is a keyword, so `const of = ...` is a syntax error reported on the whole
  declaration (`from` is fine as a name). Parenthesised untyped parameters
  (`fn (c) => ...`) are a syntax error too: write `fn c =>`.
- Reading fields of an untyped parameter (`fn c => c.size`) works in the entry
  module but fails in an imported library module with `missing_member` at the
  definition. A library function takes typed parameters, so `ink/terrain` cannot
  take a component record: it takes the fields, and the game spells them out
  once.
- A closure called many times inside a hot function is expensive. `perlin3` used
  `let g = fn i => fn j => fn k => ...` for its eight corners and spent 1.2 us
  on three octaves; writing the corners out (same results bit for bit) took 0.25
  us on the newer compiler and 2.2 to 1.0 us on `86a527b`.
- `86a527b` runs this scalar numeric code about three times slower than the
  current compiler (a `terrain.height` is 1 us there, 0.2 to 0.4 us here).
