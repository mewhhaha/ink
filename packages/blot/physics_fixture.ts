/**
 * Fixtures for the physics tests: a schema with the standard physics
 * components, a way to compile a tiny game against it, and stacks of boxes.
 */
import { join } from "@std/path";
import {
  type Catalog,
  component,
  decodeWorld,
  defineSchema,
  encodeWorld,
  f32,
  idleInput,
  list,
  sceneToWorld,
  standard,
  u32,
  vec3,
  type WorldModel,
} from "@ink/schema";
import { createGameCompiler, formatDiagnostic } from "./compiler.ts";
import { type Game, loadGame } from "./mod.ts";

export const schema = defineSchema({
  components: {
    ...standard.components,
    // Tests ask a question through this entity and read the answer from `out`.
    probe: component({
      mode: u32(),
      dir: vec3(),
      reach: f32({ default: 10 }),
      radius: f32({ default: 0.5 }),
      other: u32(),
      out: list(f32(), { max: 16 }),
    }),
  },
  resources: { ...standard.resources },
  events: { ...standard.events },
});

export const catalog: Catalog = {
  assets: { mesh: ["builtin:cube"], texture: [], sound: [] },
};

/** Compile a game whose `update` is `source` (Blot over `s`). */
export async function compileGame(source: string): Promise<Game> {
  const dir = await Deno.makeTempDir({ prefix: "ink-physics-" });
  try {
    const entry = join(dir, "main.blot");
    await Deno.writeTextFile(
      entry,
      `import * as array from "std/array"
import { Vec3 } from "std/vector"
import * as math from "ink/math"
import * as physics from "ink/physics"
import * as s from "./schema.gen"

${source}

entry const step = fn (lanes: Array F32) -> Array F32 => s.run update lanes
`,
    );
    const compiler = await createGameCompiler({ entry, schema, catalog });
    try {
      const result = await compiler.build();
      if (!result.ok) {
        throw new Error(result.diagnostics.map(formatDiagnostic).join("\n"));
      }
      return await loadGame(result.bytes, schema);
    } finally {
      await compiler.dispose();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

export const stepOnly =
  `const update = fn (input: s.Input) => fn (world: s.World) => s.physics_step input.dt world`;

export function stack(count: number, gap = 1) {
  const entities: unknown[] = [{
    id: 1,
    name: "Ground",
    components: {
      transform: { position: [0, -0.5, 0] },
      collider: { size: [40, 1, 40] },
    },
  }];
  for (let i = 0; i < count; i++) {
    entities.push({
      id: i + 2,
      components: {
        transform: { position: [0, 0.5 + i * gap, 0] },
        body: {},
        collider: {},
      },
    });
  }
  return sceneToWorld(schema, { ink: 1, entities } as never, catalog).world;
}

/** Step a packed state `ticks` times; returns the final state. */
export function run(game: Game, world: WorldModel, ticks: number) {
  let state = encodeWorld(schema, world);
  for (let tick = 0; tick < ticks; tick++) {
    state = game.step(state, idleInput(schema, tick)).state;
  }
  return state;
}

export function position(world: WorldModel, id: number): number[] {
  const entity = world.entities.find((e) => e.id === id)!;
  return entity.components.transform.position as number[];
}

/**
 * A game for probing the library. Characters walk where the `probe` entity's
 * `dir` says (mode 3 also jumps), then physics steps, then the probe asks the
 * question its `mode` names and writes the answer to `out`:
 *
 *   1 ray along dir for reach: hit, id, distance, normal.xyz, point.xyz
 *   2 sweep a sphere of `radius` along dir for reach: hit, id, distance, normal.xyz
 *   3 (jump while walking)
 *   4 overlap sphere at the probe: count, then the ids
 *   5 point solid: 0 or 1
 *   6 ray along dir for reach ignoring entity `other`
 */
export const probeGame = `
const control = fn (input: s.Input) => fn (probe: s.Probe) => fn (e: s.Entity) => do:
  let #Some c = e.character else:
    return e
  let v = c.velocity
  v.x := probe.dir.x
  v.z := probe.dir.z
  v.y := if c.grounded then (if probe.mode == 3 then 7.0 else 0.0 - 1.0) else v.y - 20.0 * input.dt
  c.velocity := v
  e.character := #Some c
  return e

const answer = fn (world: s.World) => fn (e: s.Entity) => do:
  let #Some probe = e.probe else:
    return e
  let #Some t = e.transform else:
    return e
  let scene = s.physics_scene world
  let from = t.position
  if probe.mode == 1 || probe.mode == 6:
    let skip = if probe.mode == 6 then probe.other else e.id
    let hit = physics.ray scene from probe.dir probe.reach physics.all_layers skip
    probe.out := case hit of
      #Some h => #[1.0, U32.to_f32 h.id, h.distance, h.normal.x, h.normal.y, h.normal.z, h.point.x, h.point.y, h.point.z]
      #Nothing => #[0.0]
  if probe.mode == 2:
    let hit = physics.sweep_sphere scene from probe.radius (probe.dir.normalized * probe.reach) physics.all_layers e.id
    probe.out := case hit of
      #Some h => #[1.0, U32.to_f32 h.id, h.distance, h.normal.x, h.normal.y, h.normal.z]
      #Nothing => #[0.0]
  if probe.mode == 4:
    let ids = physics.overlap_sphere scene from probe.radius physics.all_layers
    let count: F32 = U32.to_f32 ids.length
    probe.out := #[count, ...array.map U32.to_f32 ids]
  if probe.mode == 5:
    probe.out := #[if physics.point_solid scene from physics.all_layers then 1.0 else 0.0]
  e.probe := #Some probe
  return e

const update = fn (input: s.Input) => fn (world: s.World) => do:
  let probe = do:
    for e in world.entities:
      if let #Some p = e.probe:
        return p
    return s.default_probe
  world.entities := array.map (control input probe) self
  world := s.physics_step input.dt self
  world.entities := array.map (answer world) self
  return world
`;

type Spec = {
  id: number;
  name?: string;
  parent?: number;
  components: Record<string, unknown>;
};

/** A world from entity specs (scene-file shaped). */
export function level(entities: Spec[]): WorldModel {
  return sceneToWorld(schema, { ink: 1, entities } as never, catalog).world;
}

/** A static box. `position` is its centre. */
export const box = (
  id: number,
  position: number[],
  size: number[],
  extra: Record<string, unknown> = {},
): Spec => ({
  id,
  components: {
    transform: { position },
    collider: { size },
    ...extra,
  },
});

export const probeAt = (
  position: number[],
  probe: Record<string, unknown>,
): Spec => ({
  id: 900,
  components: { transform: { position }, probe },
});

/** Step a world model `ticks` times and return the final world. */
export function play(game: Game, world: WorldModel, ticks: number): WorldModel {
  return decodeWorld(schema, run(game, world, ticks));
}

export const entityOf = (world: WorldModel, id: number) =>
  world.entities.find((e) => e.id === id)!;

export const probeOut = (world: WorldModel) =>
  entityOf(world, 900).components.probe.out as number[];
