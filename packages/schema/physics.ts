/**
 * Physics: the standard `collider`, `body` and `character` components, the
 * `physics` resource, and the Blot glue between them and the physics library
 * (`ink/physics`, in packages/blot/lib).
 *
 * The library works on its own plain types and never names a game's types.
 * When a schema declares `collider`, `transform` and the `physics` resource,
 * `generateBlot` appends the glue from here: `physics_step dt world` moves the
 * characters and simulates the rigid bodies, `physics_scene world` builds the
 * scene that ray, shape-cast and overlap queries run against.
 */
import { bool, entity, enumOf, f32, list, u32, vec3 } from "./fields.ts";
import { component, type RecordDef } from "./schema.ts";
import type { Schema } from "./schema.ts";

export const collider: RecordDef = component({
  shape: enumOf(["box", "sphere", "capsule", "hull"], {
    name: "ColliderShape",
    description: "A hull uses the entity's own brush planes: any convex solid.",
  }),
  size: vec3({
    default: [1, 1, 1],
    min: 0.001,
    step: 0.1,
    unit: "m",
    group: "Shape",
    description: "Box extents, before the transform's scale.",
  }),
  radius: f32({
    default: 0.5,
    min: 0.001,
    step: 0.05,
    unit: "m",
    group: "Shape",
    description: "Sphere and capsule radius.",
  }),
  height: f32({
    default: 2,
    min: 0.002,
    step: 0.1,
    unit: "m",
    group: "Shape",
    description: "Capsule height including both caps; the capsule stands on Y.",
  }),
  offset: vec3({
    step: 0.1,
    unit: "m",
    group: "Shape",
    description:
      "Where the shape sits relative to the entity. Ignored by dynamic bodies, which turn about their origin.",
  }),
  friction: f32({ default: 0.6, min: 0, max: 2, step: 0.05, group: "Surface" }),
  restitution: f32({
    default: 0,
    min: 0,
    max: 1,
    step: 0.05,
    group: "Surface",
    description: "Bounciness.",
  }),
  layer: u32({
    default: 1,
    min: 0,
    max: 65535,
    group: "Filter",
    description: "Bit mask of the layers this collider is on.",
  }),
  mask: u32({
    default: 65535,
    min: 0,
    max: 65535,
    group: "Filter",
    description: "Bit mask of the layers this collider touches.",
  }),
  trigger: bool({
    group: "Filter",
    description:
      "Never blocks anything. Found by overlap queries, not by sweeps or the solver.",
  }),
}, {
  icon: "box",
  category: "Physics",
  description:
    "A solid shape. On its own (or with a brush) it is immovable level geometry.",
});

export const body: RecordDef = component({
  kind: enumOf(["dynamic", "kinematic", "static"], {
    name: "BodyKind",
    description:
      "Dynamic bodies are simulated; kinematic ones are moved by the game and push; static ones never move.",
  }),
  mass: f32({
    default: 1,
    min: 0.001,
    step: 0.1,
    unit: "kg",
    description: "Inertia follows from the collider's shape.",
  }),
  gravity_scale: f32({ default: 1, step: 0.1 }),
  linear_damping: f32({ default: 0, min: 0, step: 0.05, unit: "1/s" }),
  angular_damping: f32({ default: 0.05, min: 0, step: 0.05, unit: "1/s" }),
  can_sleep: bool({
    default: true,
    description: "Rests without costing anything once it has settled.",
  }),
  continuous: bool({
    default: true,
    description: "Never tunnels through thin static colliders at high speed.",
  }),
  linear_velocity: vec3({ unit: "m/s", group: "State" }),
  angular_velocity: vec3({ unit: "rad/s", group: "State" }),
  sleeping: bool({ readonly: true, group: "State" }),
  sleep_time: f32({ readonly: true, hidden: true, group: "State" }),
}, {
  icon: "cube",
  category: "Physics",
  description:
    "Makes the collider a rigid body. Kinematic bodies are moved by the game, which also sets their velocity so that they carry characters and push bodies.",
});

export const character: RecordDef = component({
  max_slope: f32({
    default: 50,
    min: 0,
    max: 89,
    step: 1,
    unit: "°",
    description: "Steepest ground it can stand and walk on.",
  }),
  step_height: f32({
    default: 0.4,
    min: 0,
    step: 0.05,
    unit: "m",
    description: "Ledges up to this high are stepped over.",
  }),
  snap_distance: f32({
    default: 0.3,
    min: 0,
    step: 0.05,
    unit: "m",
    description: "Going down, stay on the ground within this distance.",
  }),
  push: f32({
    default: 1,
    min: 0,
    step: 0.1,
    description:
      "Speed given to dynamic bodies it walks into, relative to its own.",
  }),
  velocity: vec3({
    unit: "m/s",
    group: "State",
    description:
      "What the game wants this step, gravity and jumps included. After the move: what remains once walls are slid along.",
  }),
  grounded: bool({ readonly: true, group: "State" }),
  ground: entity({ readonly: true, group: "State" }),
  ground_normal: vec3({ readonly: true, group: "State" }),
}, {
  icon: "hand",
  category: "Physics",
  description:
    "An upright capsule controller (it needs a capsule collider): slopes, steps, ground snapping and moving platforms. The game sets `velocity`; the physics step moves it.",
});

export const physics: RecordDef = component({
  gravity: vec3({ default: [0, -9.81, 0], step: 0.1, unit: "m/s²" }),
  substeps: u32({
    default: 4,
    min: 1,
    max: 16,
    description:
      "Solver substeps per step. More is stiffer and costs proportionally more.",
  }),
  sleep_time: f32({ default: 0.5, min: 0, step: 0.1, unit: "s" }),
  linear_sleep: f32({ default: 0.05, min: 0, step: 0.01, unit: "m/s" }),
  angular_sleep: f32({ default: 0.05, min: 0, step: 0.01, unit: "rad/s" }),
  contacts: list(f32(), {
    hidden: true,
    transient: true,
    max: 65535,
    description:
      "Contacts of the last step, 12 numbers each (entity ids, point, normal, impulses): warm starting and editor display.",
  }),
}, {
  category: "Physics",
  description: "World-wide physics settings.",
});

/** Resources to spread into a schema that uses physics. */
export const resources: Record<string, RecordDef> = { physics };

/** Floats per cached contact; keep in step with `ink/physics`. */
export const contactStride = 12;

// Glue ---------------------------------------------------------------------

function wantsPhysics(schema: Schema): boolean {
  return !!schema.component("collider") && !!schema.component("transform") &&
    schema.resources.some((r) => r.name === "physics");
}

/** Import lines for the generated module's header. */
export function physicsImports(schema: Schema): string {
  return wantsPhysics(schema)
    ? `import * as phys from "ink/physics"\nimport * as phys_scene from "ink/scene"\n`
    : "";
}

/** The glue appended to the generated module, or nothing without physics. */
export function physicsSection(schema: Schema): string {
  if (!wantsPhysics(schema)) return "";
  const has = (name: string) => !!schema.component(name);
  const rigid = has("body")
    ? `case e.body of
      #Some b => #Some (#phys_scene.Rigid {
        kind: phys_kind b.kind,
        mass: b.mass,
        gravity_scale: b.gravity_scale,
        linear_damping: b.linear_damping,
        angular_damping: b.angular_damping,
        can_sleep: b.can_sleep,
        continuous: b.continuous,
        linear_velocity: b.linear_velocity,
        angular_velocity: b.angular_velocity,
        sleeping: b.sleeping,
        sleep_time: b.sleep_time,
      })
      #Nothing => #Nothing`
    : "#Nothing";
  const walker = has("character")
    ? `case e.character of
      #Some c => #Some (#phys_scene.Walker {
        max_slope: c.max_slope,
        step_height: c.step_height,
        snap_distance: c.snap_distance,
        push: c.push,
        velocity: c.velocity,
        grounded: c.grounded,
        ground: c.ground,
        ground_normal: c.ground_normal,
      })
      #Nothing => #Nothing`
    : "#Nothing";
  const planes = has("brush")
    ? `case e.brush of
      #Some brush => array.map (fn (f: Face) => f.plane) brush.faces
      #Nothing => #[]`
    : "#[]";
  const applyBody = has("body")
    ? `    if let #Some state = r.rigid:
      if let #Some b = e.body:
        b.linear_velocity := state.linear_velocity
        b.angular_velocity := state.angular_velocity
        b.sleeping := state.sleeping
        b.sleep_time := state.sleep_time
        e.body := #Some b`
    : "";
  const applyWalker = has("character")
    ? `    if let #Some state = r.walker:
      if let #Some c = e.character:
        c.velocity := state.velocity
        c.grounded := state.grounded
        c.ground := state.ground
        c.ground_normal := state.ground_normal
        e.character := #Some c`
    : "";
  return `
// Physics glue (generated from the standard collider, body, character and
// brush components): see packages/schema/physics.ts and ink/physics.

const phys_shape = fn (kind: ColliderShape) => case kind of
  #Box => #phys_scene.Box
  #Sphere => #phys_scene.Sphere
  #Capsule => #phys_scene.Capsule
  #Hull => #phys_scene.Brush
${
    has("body")
      ? `
const phys_kind = fn (kind: BodyKind) => case kind of
  #Dynamic => #phys_scene.Dynamic
  #Kinematic => #phys_scene.Kinematic
  #Static => #phys_scene.Static
`
      : ""
  }
// An entity's pose in world space, through its parents.
const phys_pose = fn (world: World) => fn (e: Entity) => do:
  let #Some t = e.transform else:
    return (#Vec3 { x: 0.0, y: 0.0, z: 0.0 }, #Quat { x: 0.0, y: 0.0, z: 0.0, w: 1.0 }, #Vec3 { x: 1.0, y: 1.0, z: 1.0 })
  let position = t.position
  let rotation = t.rotation
  let scale = t.scale
  let parent = e.parent
  for 0..8:
    if parent != 0:
      if let #Some p = find parent world:
        if let #Some pt = p.transform:
          position := pt.position + phys_scene.rotate pt.rotation (phys_scene.scale_by position pt.scale)
          rotation := phys_scene.compose pt.rotation self
          scale := phys_scene.scale_by self pt.scale
        parent := p.parent
      else:
        parent := 0
  return (position, rotation, scale)

// The entities physics cares about, as the library sees them.
const phys_sources = fn (world: World) => do:
  let found: List phys_scene.Source = []
  let entities = world.entities
  for index in 0..entities.length:
    let e = entities[index]
    let collider = case e.collider of
      #Some c => #Some (#phys_scene.Collider {
        shape: phys_shape c.shape,
        size: c.size,
        radius: c.radius,
        height: c.height,
        offset: c.offset,
        friction: c.friction,
        restitution: c.restitution,
        layer: c.layer,
        mask: c.mask,
        trigger: c.trigger,
      })
      #Nothing => #Nothing
    let rigid = ${rigid}
    let walker = ${walker}
    let planes = ${planes}
    let relevant = case collider of
      #Some _ => #True
      #Nothing => case rigid of
        #Some _ => #True
        #Nothing => case walker of
          #Some _ => #True
          #Nothing => Bool.not planes.is_empty
    if relevant:
      let (position, rotation, scale) = phys_pose world e
      found := [...self, #phys_scene.Source { index, id: e.id, position, rotation, scale, collider, rigid, walker, planes }]
  return Array.from_list found

// Write what a step changed back into the entities.
const phys_apply = fn (sources: Array phys_scene.Source) => fn (results: Array phys.Result) => fn (world: World) => do:
  let old = world.entities
  let entities = @array.generate old.length (fn (i: U32) => old[i])
  for r in results:
    let index = sources[r.source].index
    let e = entities[index]
    if e.parent == 0:
      if let #Some t = e.transform:
        t.position := r.position
        t.rotation := r.rotation
        e.transform := #Some t
${applyBody}
${applyWalker}
    entities[index] := e
  world.entities := entities
  return world

// Move the characters and simulate the rigid bodies by \`dt\`.
const physics_step = fn (dt: F32) => fn (world: World) => do:
  let sources = phys_sources world
  // Nothing awake and nothing moving: the step changes nothing.
  if phys.at_rest sources:
    return world
  let sc = phys_scene.build sources
  let p = world.resources.physics
  let config = #phys.Config { gravity: p.gravity, substeps: p.substeps, sleep_time: p.sleep_time, linear_sleep: p.linear_sleep, angular_sleep: p.angular_sleep }
  let (results, contacts) = phys.simulate config dt sources sc p.contacts
  world := phys_apply sources results self
  world.resources.physics.contacts := contacts
  return world

// The world's colliders, for ray, shape-cast and overlap queries.
const physics_scene = fn (world: World) => phys_scene.build (phys_sources world)
`;
}
