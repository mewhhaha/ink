/**
 * Build a level in the tile editor with the real tools, play it and win, and
 * check the hill's gate along the way: hot reload of Blot code, tileset
 * images, atlas files, tile edits and the editor's own UI while the game is
 * playing; hand-offs, captures and a recorded scenario.
 *
 *   deno task test:tiles
 */
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import { chromium } from "playwright-core";
import { findChromium, startServer } from "@ink/dev/cli";
import { resolveProject } from "@ink/dev/node";
import { encodePng } from "@ink/render";
import type { Ink } from "../packages/react/context.tsx";
import { botKeys, type BotView } from "../examples/tiles/bot.ts";

type Boot = { ink: Ink };
type Global = { [key: symbol]: Promise<Boot> };
const root = new URL("../", import.meta.url).pathname;

await Deno.mkdir("tmp", { recursive: true });
const dir = await Deno.makeTempDir({ dir: "tmp", prefix: "ink-tiles-" });
async function copy(from: string, to: string) {
  await Deno.mkdir(to, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    if (entry.isDirectory) {
      await copy(join(from, entry.name), join(to, entry.name));
    } else if (entry.isFile) {
      await Deno.copyFile(join(from, entry.name), join(to, entry.name));
    }
  }
}
await copy("examples/tiles", dir);
const server = await startServer(await resolveProject(dir), {
  port: 0,
  quiet: true,
});
const browser = await chromium.launch({
  executablePath: await findChromium(),
  headless: true,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-features=Vulkan",
    "--use-vulkan=swiftshader",
    "--use-webgpu-adapter=swiftshader",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
  ],
});
const base = `http://127.0.0.1:${
  (server.httpServer!.address() as { port: number }).port
}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(
  get: () => Promise<T>,
  check: (value: T) => boolean,
  what: string,
  timeout = 60000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await get();
    if (check(last)) return last;
    await sleep(100);
  }
  throw new Error(
    `timed out waiting for ${what} (last: ${JSON.stringify(last)})`,
  );
}

const started = Date.now();
const lap = (what: string) =>
  console.log(
    `${((Date.now() - started) / 1000).toFixed(1).padStart(6)} s  ${what}`,
  );

try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 960 },
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/404/.test(m.text())) errors.push(m.text());
  });
  // Start with the blank map framed so the whole build fits the view.
  await page.addInitScript(() => {
    try {
      localStorage.setItem(
        "ink:camera:/:level",
        JSON.stringify({
          kind: "front",
          position: [16, 8, 0],
          yaw: 0,
          pitch: 0,
          distance: 0,
          fov: 60,
          size: 20,
        }),
      );
    } catch { /* The view frames the map itself without it. */ }
  });
  await page.goto(`${base}/?scene=blank`);
  await page.waitForSelector('[data-view-id="level"]');

  // Helpers over the page ------------------------------------------------------
  const ink = <T, A = undefined>(
    fn: (ink: Ink, arg: A) => T | Promise<T>,
    arg?: A,
  ): Promise<T> =>
    page.evaluate(
      async ({ source, arg }) => {
        const boot = await (globalThis as unknown as Global)[
          Symbol.for("ink.boot")
        ];
        return await (0, eval)(`(${source})`)(boot.ink, arg);
      },
      { source: fn.toString(), arg },
    );
  await until(
    () => ink((i) => i.session.status.kind),
    (s) => s === "ready",
    "the game to build",
  );
  await until(
    () => ink((i) => !!i.renderer && i.views.has("level")),
    Boolean,
    "the renderer",
  );
  await sleep(1500);

  const toScreen = async (x: number, y: number): Promise<[number, number]> => {
    const rect = (await page.locator('[data-view-id="level"]').boundingBox())!;
    const p = await ink(
      (i, [x, y]) => i.views.get("level")!.project([x, y, 0]),
      [x, y] as [number, number],
    );
    assert(p, "the point is in view");
    return [rect.x + p[0], rect.y + p[1]];
  };
  const cell = (cx: number, cy: number) => toScreen(cx + 0.5, cy + 0.5);
  const tool = (title: string) =>
    page.locator(`button[title^="${title}"]`).first().click();
  const tile = (id: number) => page.locator(`[data-tile="${id}"]`).click();
  const tab = (label: string) =>
    page.locator(".ink-tab, [role=tab]", { hasText: label }).first().click();
  const layer = async (name: string) => {
    await tab("Layers");
    await page.locator("[data-layer]").filter({
      has: page.getByText(name, { exact: true }),
    }).click();
  };
  const map = (name: string) =>
    ink(
      (i, name) => {
        const s = i.session;
        const e = s.world.entities.find((e) => s.nameOf(e.id) === name)!;
        const t = e.components.tilemap as { width: number; cells: number[] };
        return { width: t.width, cells: t.cells };
      },
      name,
    );
  /** Tile ids by name, from the catalog's atlas. */
  const frames = (await ink((i) => {
    const info = Object.values(i.session.catalog.atlases ?? {}).find((a) =>
      a.image === "tiles.png"
    )!;
    return info.frames;
  })).reduce((all: Record<string, number>, name, index) => {
    all[name] = index + 1;
    return all;
  }, {});
  const at = (cells: number[], width: number, x: number, y: number) =>
    cells[y * width + x];
  const drag = async (
    from: [number, number],
    to: [number, number],
    shift = false,
  ) => {
    const a = await cell(...from), b = await cell(...to);
    if (shift) await page.keyboard.down("Shift");
    await page.mouse.move(...a);
    await page.mouse.down();
    await page.mouse.move(...b, { steps: 4 });
    await page.mouse.up();
    if (shift) await page.keyboard.up("Shift");
  };
  const click = async (x: number, y: number) => {
    await page.mouse.click(...await toScreen(x, y));
  };

  const grounds = Object.keys(frames).filter((n) => n.startsWith("ground_"));
  assertEquals(grounds.length, 16, "the autotile variants come from the atlas");
  lap("editor open on the blank map");

  // Build the level --------------------------------------------------------------
  assertEquals(await ink((i) => i.session.sceneName), "blank");
  assertEquals((await map("Ground")).cells.every((c) => c === 0), true);

  // 1. A floor: rectangle tool with an auto-tiling tile.
  await tile(frames.ground_15);
  await tool("Rectangle");
  await drag([3, 0], [28, 3]);
  let ground = await map("Ground");
  assertEquals(
    at(ground.cells, ground.width, 10, 3),
    frames.ground_14, /* open top */
  );
  assertEquals(
    at(ground.cells, ground.width, 10, 1),
    frames.ground_15, /* buried */
  );
  assertEquals(
    at(ground.cells, ground.width, 3, 3),
    frames.ground_6, /* left end of the top */
  );
  lap("floor painted with the rectangle tool, edges auto-tiled");

  // 2. A pit: erase strokes, after which the rims re-tile themselves.
  await tool("Erase tiles");
  for (const x of [12, 13, 14]) await drag([x, 3], [x, 0]);
  ground = await map("Ground");
  assertEquals(at(ground.cells, ground.width, 13, 1), 0);
  assertNotEquals(at(ground.cells, ground.width, 11, 3), frames.ground_15);
  assertEquals(
    at(ground.cells, ground.width, 11, 3),
    frames.ground_12,
    "the rim's open side",
  );

  // 3. Spikes in the pit, a plank to hop on: the brush with Shift for lines.
  await tile(frames.spikes);
  await tool("Paint tiles");
  await drag([12, 0], [14, 0]);
  await tile(frames.platform);
  await click(17.5, 5.5);
  await page.keyboard.down("Shift");
  await click(20.5, 5.5);
  await page.keyboard.up("Shift");
  ground = await map("Ground");
  assertEquals(
    [17, 18, 19, 20].map((x) => at(ground.cells, ground.width, x, 5)),
    Array(4).fill(frames.platform),
  );

  // 4. Crates for steps.
  await tile(frames.crate);
  for (const [x, y] of [[23, 4], [24, 4], [24, 5]]) {
    await click(x + 0.5, y + 0.5);
  }

  // 5. Fill: a stone block floating above, converted to brick in one click.
  await tile(frames.stone);
  await tool("Rectangle");
  await drag([8, 8], [10, 9]);
  await tile(frames.brick);
  await tool("Fill");
  await click(8.5, 8.5);
  ground = await map("Ground");
  assertEquals(
    [[8, 8], [9, 9], [10, 8]].map(([x, y]) =>
      at(ground.cells, ground.width, x, y)
    ),
    Array(3).fill(frames.brick),
  );

  // 6. Decoration on another layer; the eyedropper copies a tile.
  await layer("Background");
  await tile(frames.bush);
  await tool("Paint tiles");
  await click(6.5, 4.5);
  await tool("Pick tile");
  await tile(0);
  await click(6.5, 4.5);
  assertEquals(
    await page.locator(`[data-tile="${frames.bush}"][aria-pressed="true"]`)
      .count(),
    1,
    "the picker selected the bush",
  );
  await tool("Paint tiles");
  await click(21.5, 4.5);
  const back = await map("Background");
  assertEquals(
    [[6, 4], [21, 4]].map(([x, y]) => at(back.cells, back.width, x, y)),
    [frames.bush, frames.bush],
  );
  assertEquals(
    (await map("Ground")).cells.filter((c) => c === frames.bush).length,
    0,
    "painting went to the chosen layer",
  );
  await layer("Ground");

  // 7. Objects with the place tool: hero start, coins, a slime, a torch, the flag.
  await tab("Objects");
  const place = async (id: string, x: number, y: number) => {
    await page.locator(`[data-place="${id}"]`).click();
    await click(x, y);
  };
  await place("hero", 4.5, 4.5);
  for (const [x, y] of [[8.5, 4.5], [18.5, 6.5], [19.5, 6.5], [24.5, 6.5]]) {
    await place("coin", x, y);
  }
  await place("slime", 21.5, 4.5);
  await place("torch", 6.5, 4.5);
  await place("flag", 27.5, 4.5);
  const objects = await ink((i) => {
    const s = i.session;
    const count = (c: string) =>
      s.world.entities.filter((e) => e.components[c]).length;
    return {
      coins: count("coin"),
      slimes: count("slime"),
      goals: count("goal"),
      lights: count("flicker"),
      heroes: count("hero"),
    };
  });
  assertEquals(objects, {
    coins: 4,
    slimes: 1,
    goals: 1,
    lights: 1,
    heroes: 1,
  });
  lap(
    "level built: floor, pit, spikes, planks, crates, decoration and objects",
  );

  // Undo and redo cover tile edits, one step per stroke.
  const before = (await map("Ground")).cells.join();
  await tool("Paint tiles");
  await tile(frames.stone);
  await click(6.5, 9.5);
  assertNotEquals((await map("Ground")).cells.join(), before);
  await ink((i) => i.session.undo());
  assertEquals((await map("Ground")).cells.join(), before);

  // Save: the scene file holds the level in readable rows.
  await ink((i) => i.dev!.saveScene());
  const saved = await Deno.readTextFile(join(dir, "scenes/blank.scene.json"));
  assert(saved.includes('"cells"') && saved.split("\n").length < 5000);
  assert(
    JSON.parse(saved).entities.filter((
      e: { components: Record<string, unknown> },
    ) => e.components.coin).length === 4,
  );
  await page.screenshot({ path: "tmp/tiles-editor.png" });
  lap("saved scenes/blank.scene.json");

  // Play it ----------------------------------------------------------------------
  // The bot sees the world through the session and presses keys like a person.
  const view = await ink((i) => {
    const s = i.session;
    const map = s.world.entities.find((e) => e.components.terrain)!;
    const t = map.components.tilemap as { width: number; cells: number[] };
    const info = Object.values(s.catalog.atlases!).find((a) =>
      a.image === "tiles.png"
    )!;
    return { width: t.width, cells: t.cells, flags: info.tiles };
  });
  const botView = async (): Promise<BotView> => {
    const live = await ink((i) => {
      const s = i.session;
      const hero = s.world.entities.find((e) => e.components.hero)!;
      return {
        hero: {
          position:
            (hero.components.transform as { position: number[] }).position,
          velocity: (hero.components.hero as { velocity: number[] }).velocity,
          grounded: (hero.components.hero as { grounded: boolean }).grounded,
        },
        slimes: s.world.entities.filter((e) => e.components.slime).map((e) =>
          (e.components.transform as { position: number[] }).position
        ),
        cells: (s.world.entities.find((e) => e.components.terrain)!
          .components.tilemap as { cells: number[] }).cells,
        finished: (s.world.resources.game as { finished: boolean }).finished,
      };
    });
    return {
      hero: live.hero,
      slimes: live.slimes,
      flags: (x, y) => {
        const cx = Math.floor(x), cy = Math.floor(y);
        if (cx < 0 || cy < 0 || cx >= view.width) return 0;
        return view.flags[live.cells[cy * view.width + cx]] ?? 0;
      },
    };
  };
  const press = (
    keys: { move: number; climb: number; jump: boolean; held: boolean },
  ) =>
    ink((i, k) => {
      const s = i.session;
      const input = s.input.sample(s.tick, s.dt, s.tick * s.dt);
      input.actions.move = k.move;
      input.actions.climb = k.climb;
      input.actions.jump = {
        down: k.jump || k.held,
        pressed: k.jump,
        released: false,
      };
      s.stepFrame(input);
      return (s.world.resources.game as { finished: boolean }).finished;
    }, keys);

  await ink((i) => {
    i.session.play();
    i.session.pause();
  });
  await until(
    () => ink((i) => i.session.mode),
    (m) => m === "play",
    "play mode",
  );
  const held = { jump: false };
  let steps = 0, finished = false;
  while (!finished && steps++ < 2400) {
    finished = await press(botKeys(await botView(), held));
  }
  const result = await ink((i) =>
    i.session.world.resources.game as {
      coins: number;
      total: number;
      deaths: number;
      time: number;
      finished: boolean;
    }
  );
  assert(
    result.finished,
    `the bot reached the flag (stopped after ${steps} steps)`,
  );
  assertEquals(result.total, 4);
  assert(result.coins >= 2, `collected ${result.coins} coins`);
  lap(
    `played to the flag in ${
      result.time.toFixed(1)
    } s of game time, ${result.coins}/4 coins, ${result.deaths} deaths`,
  );
  await page.screenshot({ path: "tmp/tiles-cleared.png" });

  // Hot reload while playing ---------------------------------------------------------
  // Start the saved level again and stop in the middle of it.
  await ink((i) => {
    i.session.stop();
    i.session.play();
    i.session.pause();
  });
  for (let n = 0; n < 40; n++) {
    await press({ move: 1, climb: 0, jump: false, held: false });
  }
  const playing = () =>
    ink((i) => {
      const s = i.session;
      const hero = s.world.entities.find((e) => e.components.hero)!;
      const time = s.world.entities.find((e) =>
        (e.components.hud as { slot: string } | undefined)?.slot === "time"
      )!;
      return {
        tick: s.tick,
        mode: s.mode,
        x: (hero.components.transform as { position: number[] }).position[0],
        timeText: (time.components.text as { a: number }).a,
        gameTime: (s.world.resources.game as { time: number }).time,
        revision: s.status.kind === "ready" ? s.status.revision : -1,
        origin: performance.timeOrigin,
      };
    });
  const capture = async (view: string) => (await ink(async (i, v) => {
    const mounted = i.views.get(v)!;
    await new Promise<void>((r) =>
      requestAnimationFrame(() => requestAnimationFrame(() => r()))
    );
    return await mounted.capture();
  }, view));
  const settle = () => sleep(1200);
  const mid = await playing();
  assertEquals(mid.mode, "play");
  assert(mid.x > 4.8, "the hero is on its way");
  const pictureBefore = await capture("game");

  // Blot code: the running game switches to new code, same tick, same hero.
  const mainBlot = join(dir, "game/main.blot");
  const original = await Deno.readTextFile(mainBlot);
  const patched = original.replace(
    "    text.a := floor (game.time * 10.0) / 10.0",
    "    text.a := floor game.time",
  );
  assertNotEquals(patched, original);
  await Deno.writeTextFile(mainBlot, patched);
  const afterCode = await until(
    playing,
    (p) => p.revision > mid.revision,
    "the Blot rebuild",
  );
  assertEquals([afterCode.tick, afterCode.mode, afterCode.x], [
    mid.tick,
    "play",
    mid.x,
  ]);
  await press({ move: 0, climb: 0, jump: false, held: false });
  const stepped = await playing();
  assertEquals(
    stepped.timeText,
    Math.floor(stepped.gameTime),
    "the new code runs",
  );
  lap(
    `Blot edit applied in play: tick ${afterCode.tick} kept, new code running`,
  );
  await Deno.writeTextFile(mainBlot, original);
  await until(
    playing,
    (p) => p.revision > afterCode.revision,
    "the original code back",
  );

  // A tileset image: new pixels in the very next frame, nothing restarts.
  const tilesPng = join(dir, "assets/tiles.png");
  const originalPng = await Deno.readFile(tilesPng);
  const magenta = new Uint8Array(128 * 64 * 4);
  for (let p = 0; p < 128 * 64; p++) {
    magenta.set(
      ((p % 128 >> 3) + (p / 128 >> 3)) % 2
        ? [255, 0, 255, 255]
        : [40, 0, 60, 255],
      p * 4,
    );
  }
  await Deno.writeFile(
    tilesPng,
    (await encodePng(128, 64, magenta)) as Uint8Array,
  );
  await until(
    async () => await capture("game"),
    (png) => png !== pictureBefore,
    "the new tileset image on screen",
  );
  assertEquals(
    (await playing()).tick,
    stepped.tick,
    "the game did not restart",
  );
  const gameShot = await capture("game");
  await page.screenshot({ path: "tmp/tiles-image-reload.png" });
  await Deno.writeFile(tilesPng, originalPng);
  await until(
    async () => await capture("game"),
    (png) => png !== gameShot,
    "the original tileset back",
  );
  await press({ move: 0, climb: 0, jump: false, held: false });
  lap("tileset image replaced and restored in place");

  // An atlas file: tile flags reach Blot, the palette and the game.
  const atlasPath = join(dir, "assets/tiles.atlas.json");
  const atlasText = await Deno.readTextFile(atlasPath);
  const atlas = JSON.parse(atlasText);
  const flagsOf = () =>
    ink((i) => i.session.catalog.atlases!["tiles.atlas.json"].tiles) as Promise<
      number[]
    >;
  assertEquals((await flagsOf())[frames.platform], 2);
  atlas.tiles.platform = ["solid"];
  const revisionBefore = (await playing()).revision;
  await Deno.writeTextFile(atlasPath, JSON.stringify(atlas, null, 2));
  await until(flagsOf, (f) => f[frames.platform] === 1, "the atlas flags");
  await until(
    playing,
    (p) => p.revision > revisionBefore,
    "the rebuild for new flags",
  );
  assert(
    (await Deno.readTextFile(join(dir, "game/schema.gen.blot"))).includes(
      "tileflags_tiles: Array U32",
    ),
    "Blot constants regenerated",
  );
  assertEquals(
    await page.locator(`[data-tile="${frames.platform}"]`).getAttribute(
      "title",
    ),
    "platform · solid",
    "the palette shows the new flag",
  );
  assertEquals((await playing()).tick, stepped.tick + 1);
  // A half-edited file does not take the editor down: the last good atlas stays.
  const warnings: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "warning") warnings.push(m.text());
  });
  await Deno.writeTextFile(atlasPath, '{ "image": ');
  await until(
    () => Promise.resolve(warnings.length),
    (n) => n > 0,
    "a warning about the bad atlas",
  );
  await settle();
  assertEquals(
    (await flagsOf())[frames.platform],
    1,
    "the last good atlas is kept",
  );
  await press({ move: 0, climb: 0, jump: false, held: false });
  await Deno.writeTextFile(atlasPath, atlasText);
  await until(flagsOf, (f) => f[frames.platform] === 2, "the fixed atlas");
  lap("atlas edited, broken and fixed while playing");

  // Tile edits made with the tools while the game runs change the live world.
  const heroX = (await playing()).x;
  await tool("Paint tiles");
  await tile(frames.stone);
  const wall = Math.ceil(heroX) + 2;
  await layer("Ground");
  await click(wall + 0.5, 4.5);
  await click(wall + 0.5, 5.5);
  assertEquals(
    await ink((i, [x, y]) => {
      const e = i.session.world.entities.find((e) => e.components.terrain)!;
      const t = e.components.tilemap as { width: number; cells: number[] };
      return t.cells[y * t.width + x];
    }, [wall, 4] as [number, number]),
    frames.stone,
  );
  for (let n = 0; n < 90; n++) {
    await press({ move: 1, climb: 0, jump: false, held: false });
  }
  const stopped = (await playing()).x;
  assert(
    stopped < wall - 0.3 && stopped > heroX,
    `the new wall stops the hero (${heroX} to ${stopped}, wall at ${wall})`,
  );
  lap("a wall painted during play stopped the hero");

  // The editor's own code: React Fast Refresh keeps the session.
  const appFile = join(dir, "src/app.tsx");
  const app = await Deno.readTextFile(appFile);
  const before2 = await playing();
  await Deno.writeTextFile(
    appFile,
    app.replace('subtitle="tile editor"', 'subtitle="tile studio"'),
  );
  await until(
    async () => await page.locator(".ink-brand").innerText(),
    (text) => text.includes("tile studio"),
    "the edited toolbar",
  );
  const after2 = await playing();
  assertEquals([after2.origin, after2.tick, after2.mode], [
    before2.origin,
    before2.tick,
    "play",
  ], "no reload");
  await Deno.writeTextFile(appFile, app);
  lap("editor UI edited in place, the game kept playing");

  // Layout flip: the game alone, and back.
  await page.keyboard.press("Control+g");
  await until(
    () => ink((i) => i.ui.get().layout),
    (l) => l === "game",
    "the game layout",
  );
  await page.keyboard.press("Control+g");
  await until(
    () => ink((i) => i.ui.get().layout),
    (l) => l === "editor",
    "the editor layout",
  );

  // Hand-offs and captures through the agent interface -----------------------------
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const sessions = await (await fetch(`${base}/__ink/live/sessions`)).json();
    const response = await fetch(`${base}/__ink/live/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: sessions[0].id, method, params }),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error);
    return value;
  };
  const shot = await call("capture", { view: "level" });
  assert(shot.png.startsWith("data:image/png"), "a capture of the level view");
  assert((await Deno.stat(join(dir, shot.path))).size > 1000);
  const { id } = await call("handoff", {
    action: "create",
    note: "The wall I painted stopped the hero",
  });
  const handoffDir = join(dir, ".ink/handoffs", id);
  const files = [];
  for await (const f of Deno.readDir(handoffDir)) files.push(f.name);
  for (const name of ["handoff.md", "state.scene.json", "replay.json"]) {
    assert(files.includes(name), `hand-off has ${name}: ${files}`);
  }
  const state = JSON.parse(
    await Deno.readTextFile(join(handoffDir, "state.scene.json")),
  );
  assert(
    state.entities.some((e: { name?: string }) => e.name === "Hero"),
    "the hand-off carries the world",
  );
  const handoffTick = (await playing()).tick;
  await call("play", { action: "stop" });
  await call("handoff", { action: "replay", id });
  const replayed = await playing();
  assertEquals(replayed.tick, handoffTick, "the replay reproduces the moment");
  lap("capture and hand-off written and replayed");

  // The recorded playthrough passes headlessly against its golden images, on
  // the project as it is now, with all the editing undone.
  const test = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", `${root}packages/dev/cli.ts`, "test", dir],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const report = new TextDecoder().decode(test.stdout) +
    new TextDecoder().decode(test.stderr);
  assert(test.success && report.includes("✓ playthrough"), report);
  lap("recorded playthrough passes its goldens");

  if (errors.length) throw new Error(errors.join("\n"));
  console.log("tiles ok");
} finally {
  await browser.close();
  await server.close();
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  void root;
}
