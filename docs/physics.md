# Physics

Physics is a Blot library (`ink/physics`, `ink/scene` and friends in
`packages/blot/lib`) plus three standard components. It is pure: a step reads
the world's colliders, bodies and characters and returns new transforms and
velocities. Nothing is hidden state, so rewind, replay, hand-offs and rollback
reproduce it exactly (the contact cache that warm starts the solver is a
resource in the world).

## Using it

Declare the standard components and the resource:

```ts
defineSchema({
  components: { ...standard.components }, // transform, collider, body, character, brush...
  resources: { ...standard.resources }, // physics
});
```

A game that names `collider`, `transform` and the `physics` resource gets
generated glue (`packages/schema/physics.ts`):

```blot
import * as physics from "ink/physics"

const update = fn (input: s.Input) => fn (world: s.World) => do:
  // 1. Decide how things want to move: character.velocity, kinematic body
  //    velocities and positions, impulses on body.linear_velocity...
  // 2. Step. Characters move, rigid bodies are simulated.
  world := s.physics_step input.dt self
  // 3. Ask questions.
  let scene = s.physics_scene world
  let hit = physics.ray scene eye direction 100.0 physics.all_layers player_id
  return world
```

| Component   | Meaning                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `collider`  | A shape: `box`, `sphere`, `capsule` or `hull` (the entity's own brush planes), friction, restitution, layer/mask bits, `trigger`.          |
| `body`      | Makes the collider `dynamic` (simulated), `kinematic` (moved by the game, shoves and carries) or `static`. Mass, damping, sleeping, state. |
| `character` | An upright capsule controller: `max_slope`, `step_height`, `snap_distance`, `push`; `velocity` in, `grounded`/`ground` out.                |
| `brush`     | With no `collider` it is static level geometry (solid). Add a `collider` with `trigger` to walk through it.                                |

Sizes follow the transform's scale (scale a unit cube mesh and its box collider
follows). A dynamic body turns about its origin (no `offset`); a character
ignores scale and rotation (a first-person camera turns the transform) and stays
upright. Dynamic bodies and parented colliders use the world pose; only root
entities are written back.

### Queries

Take a scene from `s.physics_scene world` (build it once per step) and a layer
mask:

- `physics.ray scene origin direction reach mask skip` → `Maybe Hit`
- `physics.sweep_sphere scene center radius delta mask skip` and
  `physics.sweep_capsule scene a b radius delta mask skip` → `Maybe Hit`
- `physics.overlap_sphere` / `overlap_capsule scene ... mask` → entity ids,
  triggers included
- `physics.point_solid scene p mask`
- `physics.touching world.resources.physics.contacts a b`

A `Hit` has `id`, `time`, `distance`, `point`, `normal` (toward the mover) and
`depth` (if it started inside).

## How it works

- **Shapes** (`shapes.blot`): a capsule (a sphere when its segment is a point)
  or a convex polytope with vertices, faces, rings and edges. Boxes are built
  directly; brushes from their planes by intersecting plane triples.
- **Narrow phase** (`contact.blot`): polytopes by the separating axis theorem
  with face clipping (up to four points, reduced deterministically) and edge
  contacts; capsules and spheres by exact closest features, with two points for
  a capsule lying on a face. Speculative contacts within a margin that grows
  with speed.
- **Broad phase** (`physics.blot`): only active movers (awake dynamic bodies,
  moving kinematic bodies and characters) start pairs. They are swept along the
  axis where they spread most, and tested against everything at rest (static
  colliders, sleeping bodies) through one array sorted by low x with a running
  maximum of high x, so each binary-searches the handful that can touch it.
  Things at rest are never paired with each other: a world that has fully
  settled skips the step entirely (`at_rest`), and a mostly settled one pays
  only for what is awake. Pairs are processed by ascending entity ids.
- **Solver** (`rigid.blot`): sequential impulses in the soft-step style. Four
  substeps (the `physics.substeps` resource; doubled when a chain of twelve
  bodies rests on one another and quadrupled at thirty, because soft contacts
  stiffen with the square of the substep rate), each integrating velocities,
  warm starting, solving soft contacts and friction, moving, and relaxing.
  Restitution after the solve. Contacts persist across steps in
  `physics.contacts` (12 numbers each: entity ids, point, normal, normal
  impulse, friction impulse). Resting contacts add rolling resistance, which is
  what lets a tall stack settle.
- **Sleeping**: islands of touching dynamic bodies sleep together when all of
  them have been still for `sleep_time`; anything awake that touches them (or
  their neighbours) wakes the whole island.
- **Continuous collision**: a fast dynamic body sweeps its inscribed sphere
  against immovable colliders and is stopped at the first surface. Casts are
  conservative advancement over exact distances, so they are exact for spheres
  and capsules.
- **Character controller** (`character.blot`): depenetrate, ride the platform
  underfoot (its velocity, plus rotation), slide horizontally with surfaces too
  steep to stand on treated as walls, step up ledges, move vertically, snap to
  the ground going down. Slope limits use the normal of the face under the
  contact, so the rounded capsule bottom stands on ledge edges. Dynamic bodies
  it walks into are shoved by `push` times its speed.

Everything is plain F32 arithmetic (+ - \* / sqrt), so Deno and Chromium step
identically; there are no hash maps or unordered iteration.

## Editors

Every viewport has a **Physics** toggle (when the world has colliders) that
draws colliders by kind (static blue, dynamic green, sleeping dark green,
kinematic orange, characters cyan, triggers yellow) and the last step's contacts
with their normals. The inspector shows the components under the "Physics"
category with grouped fields.

## Limits

- Dynamic hull colliders assume the origin is the shape's centre; their inertia
  is from the bounding box.
- Convex only. Characters are capsules; they ignore other characters.
- The mover-versus-immovable broad phase tests every immovable proxy's bounds
  per mover (cheap per test, linear in both counts); static hull data is rebuilt
  each step from brush planes.
- Soft contacts sag under load (about 0.3 m over a 50 m tower) and tall stacks
  creep sideways slowly. A 50-box tower with sleeping disabled drifts about 0.1
  m in 10 s and then holds; 60 boxes drift 0.13 m in 10 s.
