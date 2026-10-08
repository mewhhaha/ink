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
  `ink/input` (Button, Pointer), `ink/random`, `ink/packet`.
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
- Events: `use s.emit (#s.Log { message: s.message_coin, a: 1.0, b: 0.0 })`.
- Debug drawing:
  `use s.emit (#s.Line { start: a, end: b, color: math.rgb 1.0 0.2 0.2 })` draws
  in the editor views for that step (needs `standard.events`). Constructors from
  another module are qualified: `#s.Log`, `#s.Point`.
- Collision with brushes: `ink/collide` (`slide`, `ray_brush`, `planes_at`).
- Noise: `ink/noise` (`perlin1`, `perlin2`, `perlin3`, `value2`, `fbm2`, `fbm3`,
  `at`), deterministic per seed — terrain, wind, wobble, shake.
- Effectful calls need `use`: `use roll <- s.random ()`. `let` and `:=` must be
  pure.

## Compiler notes (Blot2 as of 2026-10)

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
