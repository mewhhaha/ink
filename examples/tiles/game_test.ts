/** Plays the starter level headlessly: movement, collision, ladders, pickups,
 * stomps and the goal, with a small bot that records what it did. */
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { createGameCompiler } from "@ink/blot/compiler";
import { loadGame } from "@ink/blot";
import { scenarioInputs } from "@ink/core";
import {
  type Catalog,
  decodeWorld,
  encodeWorld,
  idleInput,
  type InputModel,
  type SceneFile,
  sceneToWorld,
  type WorldModel,
} from "@ink/schema";
import { loadSchema } from "@ink/dev/node";
import { scanAssets } from "@ink/dev/catalog";
import { botKeys } from "./bot.ts";

const root = fromFileUrl(new URL(".", import.meta.url));
const schema = await loadSchema(`${root}schema.ts`, Date.now());
const catalog: Catalog = await scanAssets(`${root}assets`);
const compiler = await createGameCompiler({
  entry: `${root}game/main.blot`,
  schema,
  catalog,
});
const build = await compiler.build();
assert(build.ok, "game compiles");
await compiler.dispose();
const game = await loadGame(build.bytes, schema);

type Component = Record<string, number | number[] | boolean | string>;

export interface Play {
  world(): WorldModel;
  tick: number;
  step(input: InputModel): void;
  hero(): { position: number[]; velocity: number[]; grounded: boolean };
  inputs: InputModel[];
}

export async function start(edit?: (scene: SceneFile) => void): Promise<Play> {
  const scene: SceneFile = JSON.parse(
    await Deno.readTextFile(`${root}scenes/main.scene.json`),
  );
  edit?.(scene);
  const loaded = sceneToWorld(schema, scene, catalog);
  let state = encodeWorld(schema, loaded.world);
  const first = state[1];
  state = game.start(state, idleInput(schema, first, 0)).state;
  state[1] = first;
  const play: Play = {
    tick: first,
    inputs: [],
    world: () => decodeWorld(schema, state),
    step(input) {
      input.tick = play.tick;
      input.time = play.tick / 60;
      play.inputs.push(input);
      state = game.step(state, input).state;
      state[1] = ++play.tick;
    },
    hero() {
      const e = play.world().entities.find((x) => x.components.hero)!;
      const h = e.components.hero as Component;
      return {
        position: (e.components.transform as Component).position as number[],
        velocity: h.velocity as number[],
        grounded: h.grounded as boolean,
      };
    },
  };
  return play;
}

const keys = (
  play: Play,
  { move = 0, climb = 0, jump = false, held = false }: {
    move?: number;
    climb?: number;
    jump?: boolean;
    held?: boolean;
  },
) => {
  const input = idleInput(schema, play.tick, 1 / 60);
  input.actions.move = move;
  input.actions.climb = climb;
  input.actions.jump = { down: jump || held, pressed: jump, released: false };
  return input;
};

const game_resource = (play: Play) =>
  play.world().resources.game as {
    coins: number;
    total: number;
    deaths: number;
    time: number;
    finished: boolean;
  };

Deno.test("the hero falls onto the ground and stands still", async () => {
  const play = await start();
  for (let i = 0; i < 90; i++) play.step(keys(play, {}));
  const h = play.hero();
  assert(h.grounded);
  // Feet on the ground's top (y = 4): the body is 0.8 tall.
  assert(Math.abs(h.position[1] - 4.4) < 0.05, `y = ${h.position[1]}`);
});

Deno.test("walls stop the hero and ledges are not magic", async () => {
  const play = await start((scene) => {
    // Walk left into the world's edge: a solid wall column.
    const hero = scene.entities.find((e) => e.name === "Hero")!;
    (hero.components.transform as { position: number[] }).position = [
      2.5,
      4.4,
      0,
    ];
  });
  for (let i = 0; i < 200; i++) play.step(keys(play, { move: -1 }));
  assert(play.hero().position[0] > 0.2, "does not leave the map");
});

Deno.test("jumping reaches two tiles but not three", async () => {
  const play = await start();
  for (let i = 0; i < 40; i++) play.step(keys(play, {}));
  let apex = 0;
  play.step(keys(play, { jump: true }));
  for (let i = 0; i < 60; i++) {
    play.step(keys(play, { held: true }));
    apex = Math.max(apex, play.hero().position[1]);
  }
  assert(apex - 4.4 > 2.0 && apex - 4.4 < 2.6, `jump height ${apex - 4.4}`);
});

// The bot's inputs are the recorded playthrough.
function decide(play: Play, held: { jump: boolean }): InputModel {
  const world = play.world();
  const map = world.entities.find((e) => e.components.terrain)!;
  const tm = map.components.tilemap as { width: number; cells: number[] };
  const flags = catalog.atlases!["tiles.atlas.json"].tiles;
  const keysNow = botKeys({
    hero: play.hero(),
    slimes: world.entities.filter((e) => e.components.slime).map((e) =>
      (e.components.transform as Component).position as number[]
    ),
    flags(x, y) {
      const cx = Math.floor(x), cy = Math.floor(y);
      if (cx < 0 || cy < 0 || cx >= tm.width) return 0;
      return flags[tm.cells[cy * tm.width + cx]] ?? 0;
    },
  }, held);
  return keys(play, {
    move: keysNow.move,
    climb: keysNow.climb,
    jump: keysNow.jump,
    held: keysNow.held,
  });
}

/** The keys a bot input stands for, in the schema's default bindings. */
const keysOf = (input: InputModel): string[] => {
  const a = input.actions as Record<string, number | { down: boolean }>;
  const out: string[] = [];
  if (a.move === -1) out.push("KeyA");
  if (a.move === 1) out.push("KeyD");
  if (a.climb === 1) out.push("KeyW");
  if (a.climb === -1) out.push("KeyS");
  if ((a.jump as { down: boolean }).down) out.push("Space");
  return out;
};

Deno.test("a bot plays through the starter level and clears it", async () => {
  const play = await start();
  const held = { jump: false };
  const recorded: string[][] = [];
  const step = (input: InputModel) => {
    recorded.push(keysOf(input));
    play.step(input);
  };
  for (let i = 0; i < 90; i++) step(keys(play, {}));
  let n = 0, ladder = 0;
  while (!game_resource(play).finished && n++ < 3600) {
    step(decide(play, held));
    if (
      !ladder && play.hero().position[1] > 6 &&
      play.hero().position[0] > 32.8 && play.hero().position[0] < 34
    ) {
      ladder = play.tick;
    }
  }
  const g = game_resource(play);
  assert(g.finished, `finished after ${n} ticks at ${play.hero().position}`);
  assert(g.coins >= 6, `collected ${g.coins} of ${g.total}`);
  assertEquals(g.total, 14);
  assert(ladder > 0, "climbed the ladder");

  // The compact recording replays to the very same world.
  const steps: { ticks: number; keys?: string[] }[] = [];
  for (const k of recorded) {
    const last = steps.at(-1);
    if (last && JSON.stringify(last.keys ?? []) === JSON.stringify(k)) {
      last.ticks++;
    } else steps.push(k.length ? { ticks: 1, keys: k } : { ticks: 1 });
  }
  const replay = await start();
  const inputs = scenarioInputs(
    { schema, dt: 1 / 60 },
    { ink: 1, name: "bot", steps, checkpoints: [] },
  );
  for (const i of inputs) replay.step(i);
  assertEquals(
    JSON.stringify(replay.world().resources),
    JSON.stringify(play.world().resources),
  );
  assertEquals(replay.tick, play.tick);
  console.log(
    `cleared in ${g.time.toFixed(1)} s with ${g.coins}/${g.total} coins, ` +
      `${g.deaths} deaths; ${steps.length} key segments`,
  );
  if (Deno.env.get("INK_WRITE_PLAYTHROUGH")) {
    const image = (name: string, view = "game") => ({
      golden: `images/${name}.png`,
      view,
      width: 320,
      height: 180,
      tolerance: 2,
    });
    await Deno.writeTextFile(
      `${root}scenarios/playthrough.scenario.json`,
      JSON.stringify(
        {
          ink: 1,
          name: "Clear the starter level",
          scene: "main",
          steps,
          checkpoints: [
            {
              tick: 150,
              assertions: [{
                entity: "Hero",
                path: "components.hero.grounded",
                value: true,
              }],
              image: image("run-150"),
            },
            {
              tick: ladder,
              assertions: [{
                entity: "Hero",
                path: "components.transform.position.1",
                op: "gt",
                value: 7,
              }],
              image: image(`ladder-${ladder}`),
            },
            {
              tick: play.tick,
              assertions: [
                { path: "resources.game.finished", value: true },
                {
                  path: "resources.game.coins",
                  op: "gte",
                  value: 6,
                },
              ],
              image: image("clear"),
            },
          ],
        },
        null,
        2,
      ) + "\n",
    );
  }
});
