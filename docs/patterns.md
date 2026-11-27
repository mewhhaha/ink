# Idiomatic Patterns & Performance Cookbook

Short, representative recipes for writing fast, allocation-light Squid code with Ink.
For full compiler rules and owner contracts, see [docs/squid.md](squid.md) and [docs/architecture.md](architecture.md).

## Contents

1. [Caller-Owned Pools & `_into` Reuse](#1-caller-owned-pools--_into-reuse)
2. [Zero-Allocation `for ever:` Main Loops](#2-zero-allocation-for-ever-main-loops)
3. [Borrowed Slices vs. Explicit Checkpoints](#3-borrowed-slices-vs-explicit-checkpoints)
4. [Zero-Abstraction NaN Handling (`ink/numeric`)](#4-zero-abstraction-nan-handling-inknumeric)
5. [Incremental ECS: Batches, Cached Queries & Deltas](#5-incremental-ecs-batches-cached-queries--deltas)
6. [Prepared Static Physics, Sparse Refits & `ray_any`](#6-prepared-static-physics-sparse-refits--ray_any)
7. [Fixed Timesteps & Pose Interpolation](#7-fixed-timesteps--pose-interpolation)
8. [Frame Reuse, Matrix Caching & Retained Rendering](#8-frame-reuse-matrix-caching--retained-rendering)
9. [Immediate-Mode Sketch UI with Buffer Reuse (`ink/ui/sketch`)](#9-immediate-mode-sketch-ui-with-buffer-reuse-inkuisketch)
10. [Accessible UI & Modal Focus Scopes (`ink/ui/tree`)](#10-accessible-ui--modal-focus-scopes-inkuitree)
11. [Budgeted Crowd Flow Fields & Reusable Path Work](#11-budgeted-crowd-flow-fields--reusable-path-work)
12. [Deterministic GGPO Rollback (`ink/net/rollback`)](#12-deterministic-ggpo-rollback-inknetrollback)
13. [Word-Native Persistence & Comptime Record Codecs](#13-word-native-persistence--comptime-record-codecs)
14. [Maps, Frozen Tables & Generational Handles](#14-maps-frozen-tables--generational-handles)
15. [Squid Hot-Loop Idioms](#15-squid-hot-loop-idioms)
16. [First-Class Tests, Expected Traps & Doctests (`std/test`, `squid doc`)](#16-first-class-tests-expected-traps--doctests-stdtest-squid-doc)

---

## 1. Caller-Owned Pools & `_into` Reuse

Keep long-lived arrays owned by the caller and pass them with `own` into `_into` functions. `@storage.truncate dst 0` keeps capacity warm so steady-state frames do zero heap allocations.

```squid
func collect_active (flags: &[Bool]) -> (dst: own #[U32]) : #[U32] =>
  @storage.truncate dst 0
  for i in 0 .. flags.length:
    if flags[i]:
      @storage.push dst i
  return dst
```

**Avoid:** Returning fresh `#[...]` arrays inside per-frame loops or wrapping multiple owning arrays inside a newly constructed record each tick.

---

## 2. Zero-Allocation `for ever:` Main Loops

Squid rewinds per-iteration stack temporaries in `for ever:` loops only when every loop-carried word in a boxed `Access` record stays unchanged. Keep mutable scalar state inside a 1-element `#[Scalars]` slot and mutate pre-allocated arrays in place.

```squid
type WorldScalars is data = $WorldScalars { time: F32, score: U32, paused: Bool }
type World is data = $World {
  scalars: #[WorldScalars], // 1-element slot mutated via world.scalars[0] := ...
  positions: #[Vec3],       // pre-allocated pool mutated in place
}

func tick (world: own World) -> (dt: F32) : World =>
  let sc = world.scalars[0]
  sc.time := sc.time + dt
  world.scalars[0] := sc
  return world
```

**Avoid:** Storing mutable `F32`/`U32` fields directly on a large (> 16-word) `Access` record carried across `for ever:` iterations, or replacing pool fields with freshly allocated arrays.

---

## 3. Borrowed Slices vs. Explicit Checkpoints

Views (`&[T]`, `xs.view start end`) and access records alias live storage at zero cost; they never snapshot. Use `@storage.copy` (or a module's `copy_into`) only at explicit save/undo/rollback boundaries.

```squid
let live: #[U32] = #[10, 20, 30]
let snapshot = @storage.copy live       // independent checkpoint
let window: &[U32] = &live[0..live.length] // zero-copy invocation borrow
live[0] := 99                           // snapshot[0] is still 10
```

**Avoid:** Holding onto an access record or `Read` view expecting it to freeze state across subsequent mutations.

---

## 4. Zero-Abstraction NaN Handling (`ink/numeric`)

`ink/numeric` lets consumers pick the exact tradeoff between raw IEEE speed, dev traps, playtest telemetry, and safe release fallbacks across four composable layers.

### 4a. Unboxed opaque validated scalars

`Finite`, `NonZeroFinite`, and `UnitF32` lower to raw Wasm `f32` registers — validate once at the boundary, pay zero checks inside hot math.

```squid
import * as numeric from "ink/numeric"

func scale_speed (raw_dt: F32) -> (raw_mass: F32) : F32 =>
  let dt = numeric.Finite.from_or numeric.Finite.zero raw_dt
  let mass = numeric.NonZeroFinite.from_or numeric.NonZeroFinite.one raw_mass
  return numeric.Finite.div_by dt mass  // divisor guaranteed finite & non-zero
```

### 4b. Compile-time `NanPolicy` specialization (pure, SIMD/kernel-safe)

Static monomorphization compiles `numeric.fast_ieee` to zero extra instructions, `numeric.fallback` to an inline finite check, and `numeric.strict_trap` to an immediate panic.

```squid
import * as numeric from "ink/numeric"

func blend_ratio (policy: p) -> (a: F32) -> (b: F32) -> (v: F32) : F32 where { numeric.NanPolicy p } =>
  numeric.unlerp_with policy 0.0 a b v

// Call site chooses policy at compile time (zero vtables):
let prod = blend_ratio numeric.fast_ieee 0.0 10.0 x
let safe = blend_ratio numeric.fallback 0.0 10.0 x
let dev  = blend_ratio numeric.strict_trap 0.0 10.0 x
```

### 4c. Scoped `Numeric` effects (zero dispatch on the happy path)

Guarded calls return immediately when finite and invoke `Numeric.non_finite` only on actual NaN/Inf. Swap handlers per scope without changing simulation code.

```squid
import * as numeric from "ink/numeric"

func aim_angle (dy: F32) -> (dx: F32) : F32 ! { numeric.Numeric } =>
  numeric.safe_atan2 0.0 dy dx

// Dev/CI: trap immediately          | Release: quiet fallback
let dev_val = numeric.run_strict (func () => aim_angle y x)
let rel_val = numeric.run_fallback (func () => aim_angle y x)
// Playtest telemetry: recover AND record fault site tags
let (val, sites) = numeric.run_collecting fault_log (func () => aim_angle y x)
```

### 4d. Zero-reflection `#for #fields` record boundary guards

Validate or repair entire records at frame, physics, or save boundaries; non-float fields (`U32`, `Bool`, `Finite`) compile away completely.

```squid
import * as numeric from "ink/numeric"

type BodyState is data = $BodyState { id: U32, pos: Vec3, vel: Vec3, rot: math.Quat }

if not (numeric.record_finite body):
  let bad_field = numeric.first_non_finite_field body  // e.g. $Some "vel"
  body := numeric.sanitize_record 0.0 body
```

---

## 5. Incremental ECS: Batches, Cached Queries & Deltas

Check `query.is_current` against lightweight `SourceMeta` headers before building `query.source` membership masks, commit column edits in a coalesced batch via `commands.apply`, and consume sparse updates via `journal.read_into`.

```squid
import * as ecs from "ink/ecs"
import * as query from "ink/ecs/query"
import * as commands from "ink/ecs/commands"

let metas = #[query.source_meta 1 pos_meta, query.source_meta 2 vel_meta]
if not (query.is_current entity_meta filter metas key query_meta):
  let s1 = query.source 1 positions pos_meta mask1
  let s2 = query.source 2 velocities vel_meta mask2
  let (next_key, next_sel, next_qm) = query.select alive entity_meta filter #[s1, s2] key selected query_meta
  key := next_key
  selected := next_sel
  query_meta := next_qm

// Commit batched edits once per phase:
let (positions, pos_meta) = commands.apply alive positions pos_meta edits
```

**Avoid:** Rebuilding `query.source` masks every frame when entity and component membership revisions have not changed.

---

## 6. Prepared Static Physics, Sparse Refits & `ray_any`

Bake static level geometry once with `physics/prepared.refresh_into`, step only moving bodies with `prepared.simulate_into`, refit dynamic scenes with explicit dirty indices via `scene.update`, and prefer boolean `scene.ray_any` for line-of-sight checks.

```squid
import * as physics from "ink/physics"
import * as prepared from "ink/physics/prepared"
import * as scene from "ink/physics/scene"

// Rebuild static BVH only when revision changes:
static_access := prepared.refresh_into { lineage: 1, revision: level_rev } static_sources self
let fixed = prepared.read static_access

// Step dynamic bodies against prepared static geometry:
step := prepared.simulate_into fixed physics.default_config dt self
step := physics.apply_into self

// Fast early-exit shadow/visibility ray (skips full hit sorting):
let blocked = scene.ray_any fixed.scene eye dir reach mask skip_id
```

**Avoid:** Rebuilding the whole static collision scene every tick or calling full `scene.ray` when you only need a boolean occlusion test.

---

## 7. Fixed Timesteps & Pose Interpolation

Drive physics with `time.fixed` using an explicit catch-up cap and interpolate between the previous and current simulation poses with `transform.lerp3` for smooth rendering.

```squid
import * as time from "ink/time"
import * as transform from "ink/transform"

let $Some step = time.fixed (1.0 / 60.0) 8 remainder delta else:
  return ()
remainder := step.remainder
for 0 .. step.steps:
  prev_pose := cur_pose
  cur_pose := simulate_tick cur_pose (1.0 / 60.0)
let display_pose = transform.lerp3 prev_pose cur_pose step.alpha
```

---

## 8. Frame Reuse, Matrix Caching & Retained Rendering

Reuse one `render.FrameAccess` across frames (`render.begin_frame`), refresh only dirty draw matrices with `render/cache.update_changes`, and stream incremental GPU instance deltas with `render/retained.update_keyed`.

```squid
import * as changes from "ink/changes"
import * as render from "ink/render"
import * as cache from "ink/render/cache"

frame := render.begin_frame self
let dirty = changes.borrow false (&moved_ids[0..moved_ids.length]) (&removed_ids[0..removed_ids.length])
let (draw_cache, draw_payload) = cache.update_changes cur_poses prev_poses appearances alpha dirty draw_cache draw_payload
```

**Avoid:** Calling `render.empty_frame ()` every frame inside a long-running loop (it drops capacity of every frame vector pool).

---

## 9. Immediate-Mode Sketch UI with Buffer Reuse (`ink/ui/sketch`)

`ink/ui/sketch` renders asset-free, Drawful-style wobbly marker UI directly onto Ink's SDF (`65008`) and 2D polyline (`65006`) extensions and generates semantic accessibility nodes automatically. Use `sketch.reuse_into` to keep its four draw/a11y arrays warm across frames.

```squid
import * as sketch from "ink/ui/sketch"
import * as math from "ink/math"

ui_state := sketch.feed_events (&evs[0..evs.length]) self
ui := sketch.reuse_into self ui_state viewport time sketch.paper_theme
ui := sketch.panel "CONTROLS" (math.vec4 24.0 24.0 300.0 320.0) self
let (play, ui) = sketch.button "PLAY!" ui
let (vol, ui) = sketch.slider "VOLUME" volume 0.0 1.0 ui
let (doodle, ui) = sketch.doodle_pad 160.0 doodle ui
ui := sketch.end_panel self
let (next_state, frame) = sketch.finish_into ui frame
```

Use `sketch.finish_with_tree` instead of `finish_into` when publishing accessibility trees or asserting UI behavior in `ink/ui/testing`.

---

## 10. Accessible UI & Modal Focus Scopes (`ink/ui/tree`)

Derive node IDs from stable `(scope, local)` keys rather than draw order, and push/pop modal scopes with `tree.enter` / `tree.leave` so closing a dialog restores focus to its opener automatically.

```squid
import * as tree from "ink/ui/tree"

const scope_dialog: U32 = 4
let ok_id = tree.key scope_dialog 1

// When opening a modal dialog:
focus := tree.enter scope_dialog ok_id self

// When closing the dialog (restores previous focused node):
focus := tree.leave scope_dialog self
```

---

## 11. Budgeted Crowd Flow Fields & Reusable Path Work

Allocate `flow.Flow` or `anyangle.Work` once per agent/crowd and amortize large Dijkstra rebuilds across frames with `flow.step_into` using a per-frame expansion budget.

```squid
import * as flow from "ink/navigation/flow"
import * as anyangle from "ink/navigation/anyangle"

// Crowd flow field (amortized 256 cell expansions per frame):
if goals_changed:
  crowd_flow := flow.begin_into self nav_grid (&goal_cells[0..goal_cells.length])
let (next_flow, done) = flow.step_into crowd_flow nav_grid 256
crowd_flow := next_flow
if done:
  crowd_flow := flow.directions_into self nav_grid

// Single-agent Theta* / 8-way A* reusing `work` buffers:
let (work, res) = anyangle.search_into work nav_grid start_cell goal_cell 512 true
```

---

## 12. Deterministic GGPO Rollback (`ink/net/rollback`)

`ink/net/rollback` owns only input rings and confirmation tracking; your game owns `state` and the fixed-size snapshot `ring`, passing compile-known `step`, `save`, `load`, and `checksum` callbacks.

```squid
import * as rollback from "ink/net/rollback"

let (session, ok) = rollback.receive (&packet[0..packet.length]) session
let (session, state, ring, outcome) =
  rollback.advance rollback.repeat_last step save load checksum (&local_input[0..lanes]) session state ring
let out_packet = rollback.encode session peer_id 1
```

Size the snapshot ring to `rollback.snapshots config` slots (`config.window + 1`).

---

## 13. Word-Native Persistence & Comptime Record Codecs

Combine `#for #fields` record codecs (`ink/codec`) with `ink/persist/words` to get exact U32 IEEE-754 bit round-trips (no 24-bit F32 ID loss) and schema-versioned sections without hand-written boilerplate.

```squid
import * as codec from "ink/codec"
import * as words from "ink/persist/words"

type SaveHeader is data = $SaveHeader {
  @[$FieldId 1] tick: U32,
  @[$FieldId 2] seed: U32,
  @[$Skip]      transient: U32 = 0,
}

let encoded = codec.encode_record 1 42 header
let w = words.append_section 10 1 encoded (words.writer ())
save_buf := words.frame words.magic 1 w self
```

---

## 14. Maps, Frozen Tables & Generational Handles

- Use `ink/map` (`map.empty ()` + explicit policy like `map.u32`) for mutable caller-owned hash tables.
- Use `ink/map/frozen` (`frozen.from`) for read-mostly lookup tables built once at load time (dense open addressing, stable order).
- Use `ink/handles` (`handles.Store`) when you need opaque typed handles that reject stale generations and cross-store misuse.

```squid
import * as handles from "ink/handles"

type UnitTag is data = $UnitTag
let store: handles.Store [UnitTag, Vec3] = handles.empty $UnitTag 1 1 64
let (maybe_h, store) = handles.insert $UnitTag (math.vec3 1.0 0.0 0.0) store
```

---

## 15. Squid Hot-Loop Idioms

Small patterns that eliminate indirect calls, extra copies, and borrow/ownership friction in hot Squid loops (full notes in [docs/squid.md](squid.md)):

| Pattern | Fast & Idiomatic | Why |
| --- | --- | --- |
| **View indexing** | Call `values.at i` directly inside loops | Avoid `let f: U32 -> U32 = values.at`, which blocks specialization and forces ~3× slower indirect calls |
| **Looping arrays** | Prefer `for item in rows:` when not moving the owning record afterward | Direct element iteration avoids repeated bounds/field reloads |
| **Loop before moving an `own` record** | Use `for k in 0 .. rec.items.length: let x = rec.items[k]` | `for x in rec.items:` keeps the borrow alive and can trigger `OWN_ARGUMENT` if `rec` is later passed to an `own` parameter |
| **Conditional `own` array replacement** | Route through `func adopt (dst: own #[T]) -> (src: own #[T]) : #[T]` | Assigning a freshly allocated array into an `own` parameter inside an `if` branch can trigger `RESULT_NOT_OWNED` |
| **Updating an array element's field** | `let row = xs[i]; row.x := v; xs[i] := row` (or a pure helper `xs[i] := update self`) | Direct `xs[i].x := v` on a value read out of an array can trigger `ALIASED_UPDATE` |
| **Breaking out of nested `own` mutation** | Prefer early `return state` over `else: break` when the loop ends the function | `else: break` around a nested loop mutating an `own` record can trigger `ALIASED_UPDATE` |
| **Long boolean `if` headers** | Bind `let ok = (a and b and c)` before `if ok:` | Multi-line `if ...:` conditions can trip `LAYOUT_SUITE` indentation rules |
| **Flat inner math** | Accumulate `F32` scalars directly in tight inner loops | Avoids per-iteration temporary `Vec3`/`Quat` record packing inside O(N²) loops |

---

## 16. First-Class Tests, Expected Traps & Doctests (`std/test`, `squid test`, `squid doc`)

Write Squid test suites using `@[test.suite]` with `test "..." :` and `test expect_trap "..." :` declarations plus `std/test` assertions. Bind pure helper calls or `.length` projections in `let` locals before `use test.*`, and return observed tuples out of `own`-taking CPS helpers before asserting.

```squid
import * as test from "std/test"
import * as math from "ink/math"

@[test.suite]
test "unit vector length and expected trap":
  let v = math.vec3 3.0 4.0 0.0
  let len = v.length
  use test.near "length" 1e-5 5.0 len
  return ()

test expect_trap "rejects invalid argument":
  panic "out of range"
```

Document modules with top-of-file `//!` headers, verified intra-doc symbol links (`` [`Symbol`] ``), and runnable ```` ```squid ```` examples checked by `squid doc ink --check-links --test`. Run `squid test` standalone via `squid.json` or `pen test-squid` for Squid + Rust + headless GPU checks.
