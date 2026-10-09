/** Plays the starter level headlessly: walking, collision, door, pickups, crates. */
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { createGameCompiler } from "@ink/blot/compiler";
import { loadGame } from "@ink/blot";
import {
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

const root = fromFileUrl(new URL(".", import.meta.url));
const schema = await loadSchema(`${root}schema.ts`, Date.now());
const catalog = await scanAssets(`${root}assets`);
const compiler = await createGameCompiler({
  entry: `${root}game/main.blot`,
  schema,
  catalog,
});
const build = await compiler.build();
assert(build.ok, "game compiles");
const game = await loadGame(build.bytes, schema);

interface Play {
  world(): WorldModel;
  step(count: number, change?: (input: InputModel, tick: number) => void): void;
  player(): {
    position: number[];
    velocity: number[];
    yaw: number;
    grounded: boolean;
  };
}

async function start(edit?: (scene: SceneFile) => void): Promise<Play> {
  const scene: SceneFile = JSON.parse(
    await Deno.readTextFile(`${root}scenes/main.scene.json`),
  );
  edit?.(scene);
  const loaded = sceneToWorld(schema, scene, catalog);
  let state = encodeWorld(schema, loaded.world);
  const first = state[1];
  state = game.start(state, idleInput(schema, first, 0)).state;
  state[1] = first;
  let tick = first;
  const world = () => decodeWorld(schema, state);
  return {
    world,
    step(count, change) {
      for (let i = 0; i < count; i++) {
        const input = {
          ...idleInput(schema, tick, 1 / 60),
          time: (tick - first) / 60,
        };
        change?.(input, i);
        state = game.step(state, input).state;
        state[1] = ++tick;
      }
    },
    player() {
      const e = world().entities.find((x) => x.components.player)!;
      const p = e.components.player as { yaw: number };
      const c = e.components.character as {
        velocity: number[];
        grounded: boolean;
      };
      return {
        position: (e.components.transform as { position: number[] }).position,
        ...p,
        ...c,
      };
    },
  };
}

const forward = (input: InputModel) => (input.actions.move = [0, 1]);

Deno.test("the player settles on the floor and stays inside the start room", async () => {
  const play = await start();
  play.step(90);
  const p = play.player();
  assert(p.grounded);
  assert(
    Math.abs(p.position[1] - 0.4) < 0.1,
    `feet sphere rests on the floor: ${p.position[1]}`,
  );
  play.step(240, (i) => (i.actions.move = [1, 0]));
  assert(play.player().position[0] < 5.7, "the east wall stops the player");
});

Deno.test("walking north opens the door and leads into the hall", async () => {
  const play = await start();
  play.step(60);
  play.step(80, forward);
  const door = () =>
    play.world().entities.find((e) => e.components.door)!.components.door as {
      open: number;
    };
  play.step(60, forward);
  assert(door().open > 0.9, `door open ${door().open}`);
  play.step(220, forward);
  const p = play.player();
  assert(p.position[2] < -15, `reached the hall: z=${p.position[2]}`);
  assert(Math.abs(p.position[0]) < 1.6);
});

Deno.test("the closed door blocks the corridor", async () => {
  const play = await start((scene) => {
    for (const e of scene.entities) {
      const door = e.components.door as { reach: number } | undefined;
      if (door) door.reach = 0.1;
    }
  });
  play.step(60);
  play.step(400, forward);
  assert(
    play.player().position[2] > -10,
    `blocked at ${play.player().position[2]}`,
  );
});

Deno.test("touching a pickup collects it", async () => {
  const play = await start((scene) => {
    const spawn = scene.entities.find((e) => e.name === "info_player_start")!;
    (spawn.components.transform as { position: number[] }).position = [
      -4.8,
      0.5,
      -3.5,
    ];
  });
  play.step(30);
  const stats = () =>
    play.world().resources.stats as { ammo: number; found: number };
  const ammo = stats().ammo;
  play.step(120, (i) => (i.actions.move = [0, 1]));
  assertEquals(stats().ammo, ammo + 8);
  assertEquals(stats().found, 1);
});

Deno.test("stairs can be climbed", async () => {
  const play = await start((scene) => {
    const spawn = scene.entities.find((e) => e.name === "info_player_start")!;
    const t = spawn.components.transform as { position: number[] };
    t.position = [7, 0.5, -15.2];
    (spawn.components.player as { yaw: number }).yaw = 0;
    for (const e of scene.entities) {
      const door = e.components.door as { reach: number } | undefined;
      if (door) door.reach = 0.1;
    }
  });
  play.step(30);
  let top = 0;
  for (let k = 0; k < 8; k++) {
    play.step(20, forward);
    top = Math.max(top, play.player().position[1]);
  }
  assert(top > 2.5, `reached the landing: y=${top}`);
});

Deno.test("acid hurts", async () => {
  const play = await start((scene) => {
    const spawn = scene.entities.find((e) => e.name === "info_player_start")!;
    (spawn.components.transform as { position: number[] }).position = [
      0,
      0.5,
      -24.5,
    ];
  });
  play.step(60);
  const health = (play.world().resources.stats as { health: number }).health;
  assert(health < 95, `health ${health}`);
});

Deno.test("shooting breaks a crate", async () => {
  const play = await start((scene) => {
    const spawn = scene.entities.find((e) => e.name === "info_player_start")!;
    (spawn.components.transform as { position: number[] }).position = [
      15,
      0.5,
      -21.5,
    ];
    // Face west (-X): yaw of +90 degrees turns left from north.
    (spawn.components.player as { yaw: number }).yaw = Math.PI / 2;
  });
  play.step(20);
  const crates = () =>
    play.world().entities.filter((e) => e.components.breakable).length;
  const before = crates();
  for (let n = 0; n < 4; n++) {
    play.step(
      2,
      (
        i,
        k,
      ) => (i.actions.fire = {
        down: k === 0,
        pressed: k === 0,
        released: false,
      }),
    );
  }
  assert(crates() < before, `crates ${before} -> ${crates()}`);
});
