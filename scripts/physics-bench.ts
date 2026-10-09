/**
 * Step cost of the physics library, headless (Deno): a 50-box stack, a pile of
 * 200 mixed bodies, and the first-person character walking the TrenchBroom
 * level. Prints the median and 95th percentile of `game.step`, which includes
 * packing the world, decoding the result and the whole game's other systems.
 * Run `deno run -A scripts/physics-bench.ts` on an otherwise idle machine; a
 * 60 Hz frame is 16.7 ms.
 */
import { fromFileUrl } from "@std/path";
import { createGameCompiler } from "@ink/blot/compiler";
import { loadGame } from "@ink/blot";
import {
  encodeWorld,
  idleInput,
  type SceneFile,
  sceneToWorld,
} from "@ink/schema";
import { loadSchema } from "@ink/dev/node";
import { scanAssets } from "@ink/dev/catalog";
import {
  box,
  compileGame,
  level,
  schema,
  stack,
  stepOnly,
} from "../packages/blot/physics_fixture.ts";

function report(label: string, times: number[]) {
  const sorted = [...times].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.floor(sorted.length * p)].toFixed(2);
  console.log(
    `${label.padEnd(44)} median ${at(0.5)} ms  p95 ${at(0.95)} ms  max ${
      sorted[sorted.length - 1].toFixed(2)
    } ms`,
  );
}

const game = await compileGame(stepOnly);

function time(world: ReturnType<typeof stack>, ticks: number) {
  let state = encodeWorld(schema, world);
  const times: number[] = [];
  for (let t = 0; t < ticks; t++) {
    const start = performance.now();
    state = game.step(state, idleInput(schema, t)).state;
    times.push(performance.now() - start);
  }
  return times;
}

const tower = time(stack(50), 600);
report("50 boxes stacked, 600 ticks (settles, sleeps)", tower);
report("  while awake (ticks 5-60)", tower.slice(5, 60));

const entities: Parameters<typeof level>[0] = [
  box(1, [0, -0.5, 0], [40, 1, 40]),
  box(2, [-8, 2, 0], [1, 4, 16]),
  box(3, [8, 2, 0], [1, 4, 16]),
  box(4, [0, 2, -8], [16, 4, 1]),
  box(5, [0, 2, 8], [16, 4, 1]),
];
let seed = 12345;
const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
for (let i = 0; i < 200; i++) {
  const kind = i % 3;
  entities.push({
    id: 10 + i,
    components: {
      transform: {
        position: [
          (random() - 0.5) * 12,
          1 + (i / 25) * 1.3,
          (random() - 0.5) * 12,
        ],
        rotation: [random() * 0.3, random() * 0.3, random() * 0.3, 1],
      },
      collider: kind === 0
        ? { size: [0.8 + random() * 0.4, 0.8 + random() * 0.4, 1] }
        : kind === 1
        ? { shape: "sphere", radius: 0.35 + random() * 0.2 }
        : { shape: "capsule", radius: 0.25, height: 1.2 },
      body: {},
    },
  });
}
const pile = time(level(entities), 600);
report("200 boxes, spheres and capsules dropped in a pen", pile);
report("  while settling (ticks 20-200)", pile.slice(20, 200));
report("  after most have slept (ticks 400-600)", pile.slice(400));
game.dispose();

// The first-person character in a brush level (TrenchBroom).
const root = fromFileUrl(new URL("../examples/trenchbroom/", import.meta.url));
const tbSchema = await loadSchema(`${root}schema.ts`, Date.now());
const catalog = await scanAssets(`${root}assets`);
const compiler = await createGameCompiler({
  entry: `${root}game/main.blot`,
  schema: tbSchema,
  catalog,
});
const build = await compiler.build();
if (!build.ok) throw new Error("TrenchBroom does not compile");
const tb = await loadGame(build.bytes, tbSchema);
const scene: SceneFile = JSON.parse(
  await Deno.readTextFile(`${root}scenes/main.scene.json`),
);
let state = encodeWorld(tbSchema, sceneToWorld(tbSchema, scene, catalog).world);
const first = state[1];
state = tb.start(state, idleInput(tbSchema, first, 0)).state;
state[1] = first;
const walk: number[] = [];
for (let t = 0; t < 420; t++) {
  const input = { ...idleInput(tbSchema, first + t, 1 / 60) };
  if (t > 60) input.actions.move = [0, 1];
  const start = performance.now();
  state = tb.step(state, input).state;
  walk.push(performance.now() - start);
}
report("TrenchBroom: walk through 47 brushes (whole game)", walk);
tb.dispose();
await compiler.dispose();
