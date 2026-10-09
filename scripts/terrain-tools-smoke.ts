/**
 * Sculpt, paint and scatter with the real terrain tools in the browser editor
 * on a small world, and check what the hill promises of them: every stroke is
 * one undo step that carries the data, the scene's revision and the collision
 * grid; the edits reach the asset files at once, byte for byte, without the
 * editor reloading what it just saved; a script's edit of the file still
 * reloads; the brush keys, shortcuts and modifiers work; new terrain can be
 * made from the panel.
 *
 *   deno task test:terrain-tools
 */
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { chromium } from "playwright-core";
import { findChromium, startServer } from "@ink/dev/cli";
import { resolveProject } from "@ink/dev/node";
import { collisionGrid, Heightfield, ScatterSet } from "@ink/geometry";
import {
  noiseRelief,
  paintLayer,
  planAdd,
  raise,
  scatterCandidates,
} from "@ink/terrain";
import type { Ink } from "../packages/react/context.tsx";

type Boot = { ink: Ink };
type Global = { [key: symbol]: Promise<Boot> };

const SIZE = 256;
const TERRAIN = "terrain/small.terrain";
const SCATTER = "scatter/trees.scatter";

await Deno.mkdir("tmp", { recursive: true });
const dir = await Deno.makeTempDir({
  dir: "tmp",
  prefix: "ink-terrain-tools-",
});

// The project: a 256 m terrain with hills and 200 trees, and a small editor.
async function write(path: string, text: string | Uint8Array) {
  await Deno.mkdir(join(dir, path, ".."), { recursive: true });
  if (typeof text === "string") await Deno.writeTextFile(join(dir, path), text);
  else await Deno.writeFile(join(dir, path), text);
}
await write(
  "ink.config.ts",
  `import { defineProject } from "@ink/dev";
export default defineProject({ title: "Terrain tools" });
`,
);
await write(
  "schema.ts",
  `import { defineSchema, standard } from "@ink/schema";
export default defineSchema({
  components: { ...standard.components, ...standard.componentsWorld },
  events: { ...standard.events },
  actions: {},
});
`,
);
await write(
  "game/main.blot",
  `import * as s from "./schema.gen"
const update = fn (input: s.Input) => fn (world: s.World) => world
entry const step = fn (lanes: Array F32) -> Array F32 => s.run update lanes
`,
);
await write(
  "index.html",
  `<!doctype html><html><head><meta charset="UTF-8" /><title>Terrain tools</title></head>
<body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>
`,
);
await write(
  "src/main.tsx",
  `import { createRoot } from "react-dom/client";
import "@ink/react/styles.css";
import { App } from "./app.tsx";
createRoot(document.getElementById("root")!).render(<App />);
`,
);
await write(
  "src/app.tsx",
  `import {
  HistoryButtons, InkApp, Inspector, Outliner, Pane, Panel, Spacer, Split,
  ToolPicker, TopBar, Viewport, Workspace,
} from "@ink/react";
import {
  createTerrainTools, NewScatterForm, NewTerrainForm, TerrainBrushPanel,
  terrainCommands, TerrainHint, TerrainToolbar,
} from "@ink/terrain";

const tools = createTerrainTools();

export function App() {
  return (
    <InkApp project="tmp" title="Terrain tools" tools={tools} commands={terrainCommands}>
      <TopBar>
        <HistoryButtons />
        <ToolPicker />
        <TerrainToolbar tools={tools} />
        <TerrainHint />
        <Spacer />
      </TopBar>
      <Workspace>
        <Split id="columns">
          <Pane size={240}><Panel title="Scene"><Outliner /></Panel></Pane>
          <Pane>
            <Viewport id="main" grid={false} tools={tools} quality="low" renderScale={0.5} temporal={false} />
          </Pane>
          <Pane size={320}>
            <Split id="right" direction="column">
              <Pane size={200}><Panel title="Inspector"><Inspector /></Panel></Pane>
              <Pane>
                <Panel title="Terrain">
                  <TerrainBrushPanel />
                  <NewTerrainForm />
                  <NewScatterForm />
                </Panel>
              </Pane>
            </Split>
          </Pane>
        </Split>
      </Workspace>
    </InkApp>
  );
}
`,
);
{
  const field = Heightfield.create(SIZE, { splatCells: SIZE / 2, layers: 4 });
  const ground = { field, size: SIZE };
  const wide = { shape: "constant", hardness: 0 } as const;
  noiseRelief(ground, { x: 0, z: 0, radius: 300, falloff: wide }, {
    seed: 3,
    scale: 120,
    octaves: 3,
    metres: 14,
  });
  raise(ground, {
    x: 40,
    z: -30,
    radius: 60,
    falloff: { shape: "smooth", hardness: 0 },
  }, 18);
  paintLayer(
    ground,
    { x: 40, z: -30, radius: 40, falloff: { shape: "smooth", hardness: 0.3 } },
    1,
    1,
  );
  await write(`assets/${TERRAIN}`, field.serialize());
  const trees = new ScatterSet();
  const brush = {
    seed: 2,
    density: 0.004,
    minSpacing: 3,
    scale: [0.8, 1.2] as [number, number],
    tint: [0, 1] as [number, number],
  };
  for (
    const p of planAdd(trees, scatterCandidates(brush, -60, 60, 50, wide), 3)
  ) {
    trees.add(p);
  }
  await write(`assets/${SCATTER}`, trees.serialize());
  const params = {
    size: SIZE,
    heightScale: 1,
    detail: { seed: 1, amplitude: 0.35, wavelength: 6, octaves: 3 },
  };
  const layer = (color: number[]) => ({ color: [...color, 1], tiling: 6 });
  await write(
    "scenes/main.scene.json",
    JSON.stringify({
      ink: 1,
      seed: 1,
      nextEntity: 6,
      entities: [
        {
          id: 1,
          name: "Environment",
          components: {
            environment: {
              sky: "procedural",
              ambient: 1,
              exposure: 0.4,
              tonemap: "agx",
            },
          },
        },
        {
          id: 2,
          name: "Sun",
          components: {
            transform: {
              position: [0, 100, 0],
              rotation: [-0.309561, -0.321447, -0.112077, 0.887853],
            },
            light: { kind: "directional", intensity: 1.8, shadows: false },
          },
        },
        {
          id: 3,
          name: "Ground",
          components: {
            transform: {},
            terrain: {
              heightmap: TERRAIN,
              size: SIZE,
              layers: [
                layer([0.36, 0.52, 0.22]),
                layer([0.5, 0.48, 0.45]),
                layer([0.42, 0.31, 0.2]),
                layer([0.78, 0.7, 0.5]),
              ],
              collision_cells: 32,
              grid: Array.from(collisionGrid(field, params, 32)),
            },
          },
        },
        {
          id: 4,
          name: "Trees",
          components: {
            transform: {},
            scatter: {
              shape: "builtin:cone",
              placements: SCATTER,
              color: [0.2, 0.5, 0.25, 1],
            },
          },
        },
        {
          id: 5,
          name: "Camera",
          components: {
            transform: { position: [0, 120, 200] },
            camera: { active: true, far: 2000 },
          },
        },
      ],
    }),
  );
}

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
const started = Date.now();
const lap = (what: string) =>
  console.log(
    `${((Date.now() - started) / 1000).toFixed(1).padStart(6)} s  ${what}`,
  );

try {
  const page = await browser.newPage({
    viewport: { width: 1500, height: 900 },
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/404/.test(m.text())) errors.push(m.text());
  });
  // Look down on the terrain from the south.
  await page.addInitScript(() => {
    localStorage.setItem(
      "ink:camera:/:main",
      JSON.stringify({
        kind: "perspective",
        position: [0, 130, 150],
        yaw: 0,
        pitch: -0.62,
        distance: 150,
        fov: 60,
        size: 10,
      }),
    );
  });
  await page.goto(base);
  await page.waitForSelector('[data-view-id="main"]', { timeout: 60000 });

  const ink = <R, A = undefined>(
    fn: (ink: Ink, arg: A) => R | Promise<R>,
    arg?: A,
  ): Promise<R> =>
    page.evaluate(async ({ source, arg }) => {
      const boot = await (globalThis as unknown as Global)[
        Symbol.for("ink.boot")
      ];
      return await (0, eval)(`(${source})`)(boot.ink, arg);
    }, { source: fn.toString(), arg });
  const until = async <R>(
    get: () => Promise<R>,
    ok: (value: R) => boolean,
    what: string,
    timeout = 60000,
  ) => {
    const end = Date.now() + timeout;
    let last: R | undefined;
    while (Date.now() < end) {
      last = await get();
      if (ok(last)) return last;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${what} (${JSON.stringify(last)})`);
  };
  await until(
    () => ink((i) => !!i.renderer && i.views.has("main")),
    Boolean,
    "the renderer",
  );
  await until(
    () =>
      ink(
        (i, p) =>
          [
            i.renderer!.assets.terrain(p[0]).state,
            i.renderer!.assets.scatter(p[1]).state,
          ].join(),
        [TERRAIN, SCATTER],
      ),
    (v) => v === "ready,ready",
    "the terrain and scatter data",
  );
  await sleep(1500);
  const rect = (await page.locator('[data-view-id="main"]').boundingBox())!;

  // Helpers -----------------------------------------------------------------------
  /** Page coordinates of the ground at terrain-local (x, z). */
  const screen = async (x: number, z: number): Promise<[number, number]> => {
    const p = await ink((i, [x, z]) => {
      const f = i.renderer!.assets.terrain("terrain/small.terrain").field!;
      return i.views.get("main")!.project([
        x,
        f.sampleCell(x + 128, z + 128),
        z,
      ]);
    }, [x, z] as [number, number]);
    assert(p, "the point is in view");
    return [rect.x + p[0], rect.y + p[1]];
  };
  const stroke = async (
    a: [number, number],
    b: [number, number],
    keys: string[] = [],
  ) => {
    const [ax, ay] = await screen(...a), [bx, by] = await screen(...b);
    for (const k of keys) await page.keyboard.down(k);
    await page.mouse.move(ax, ay);
    await page.mouse.down();
    await page.mouse.move(bx, by, { steps: 8 });
    await page.mouse.up();
    for (const k of keys) await page.keyboard.up(k);
  };
  const tool = (id: string) =>
    ink((i, id) => i.ui.set({ tool: id as never }), id);
  const state = () =>
    ink((i) => {
      const data = i.renderer!.assets.terrain("terrain/small.terrain");
      const t = i.session.entity(3)!.components.terrain;
      const history = i.session.history().undo;
      return {
        data: data.revision,
        scene: t.revision as number,
        steps: history.length,
        last: history.at(-1) ?? "",
        sum: data.field!.heights.reduce((s, v) => s + v, 0),
      };
    });
  const heights = () =>
    ink((i) =>
      Array.from(
        i.renderer!.assets.terrain("terrain/small.terrain").field!.heights,
      )
    );
  const splat = () =>
    ink((i) =>
      Array.from(
        i.renderer!.assets.terrain("terrain/small.terrain").field!.splat,
      )
    );
  const steps = (n: number) =>
    until(
      async () => (await state()).steps,
      (s) => s === n,
      `${n} undo steps`,
      30000,
    );
  const onDisk = async () =>
    Heightfield.parse(await Deno.readFile(join(dir, "assets", TERRAIN)));
  const undo = async () => {
    const before = (await state()).steps;
    await page.keyboard.press("Control+z");
    await steps(before - 1);
  };
  const reloads = () =>
    ink((i) =>
      i.session.log.filter((l: { text: string }) =>
        l.text.startsWith("reloaded")
      ).length
    );
  lap("editor open on the small world");

  // 1. The panel and the toolbar ---------------------------------------------------
  await ink((i) => i.session.select([3]));
  await page.waitForSelector('[data-testid="terrain-panel"]');
  assertEquals(
    await page.locator('[data-testid="terrain-state"]').innerText(),
    `${TERRAIN} · revision 0`,
  );
  await page.mouse.move(rect.x + 100, rect.y + 100);
  for (
    const [key, id] of [
      ["1", "terrain-raise"],
      ["2", "terrain-lower"],
      ["3", "terrain-smooth"],
      ["4", "terrain-flatten"],
      ["5", "terrain-noise"],
      ["6", "terrain-paint"],
      ["7", "scatter-paint"],
    ]
  ) {
    await page.keyboard.press(key);
    await until(
      () => ink((i) => i.ui.get().tool as string),
      (t) => t === id,
      `shortcut ${key}`,
      5000,
    );
  }
  lap("seven tools on the keys 1 to 7");

  // 2. Raise: one drag, one undo step, in the file without a reload ------------------
  await tool("terrain-raise");
  const flat = await heights();
  const before = await state();
  await stroke([-30, -10], [30, 20]);
  await until(
    async () => (await state()).data,
    (r) => r > 0,
    "the stroke to be recorded",
    30000,
  );
  const after = await state();
  assertEquals(
    after.scene,
    after.data,
    "the scene records the data's revision",
  );
  assertEquals(after.steps, before.steps + 1);
  assertEquals(after.last, "Raise ground");
  assert(after.sum > before.sum + 1000, "the ground rose");
  const raised = await heights();
  await until(
    async () => (await onDisk()).revision,
    (r) => r === after.data,
    "the file's revision",
  );
  assertEquals(
    (await onDisk()).heights,
    new Float32Array(raised),
    "the file holds the heights",
  );
  assertEquals(await reloads(), 0, "the editor did not reload its own save");
  assertEquals(
    await ink((i) =>
      Array.from(i.session.entity(3)!.components.terrain.grid as number[])
    ),
    await ink((i) => {
      const f = i.renderer!.assets.terrain("terrain/small.terrain").field!;
      const out: number[] = [];
      for (let z = 0; z <= 32; z++) {
        for (let x = 0; x <= 32; x++) {
          out.push(Math.fround(f.sampleCell(x * 8, z * 8)));
        }
      }
      return out;
    }),
    "the collision grid follows the heights",
  );
  lap("a raise stroke: one step, saved, grid refreshed");

  // 3. Undo and redo move the data, the file and the scene together -----------------
  await page.keyboard.press("Control+z");
  await until(async () => (await state()).data, (r) => r === 0, "the undo");
  assertEquals(await heights(), flat);
  await until(
    async () => (await onDisk()).revision,
    (r) => r === 0,
    "the file after undo",
  );
  assertEquals((await onDisk()).heights, new Float32Array(flat));
  await page.keyboard.press("Control+Shift+z");
  await until(
    async () => (await state()).data,
    (r) => r === after.data,
    "the redo",
  );
  assertEquals(await heights(), raised);
  await until(
    async () => (await onDisk()).revision,
    (r) => r === after.data,
    "the file after redo",
  );
  assertEquals((await onDisk()).heights, new Float32Array(raised));
  assertEquals(await reloads(), 0, "undo and redo did not reload either");
  lap("undo and redo carry data, file and grid");

  // 4. Brush keys, modifiers, Escape -----------------------------------------------
  const radius = async () =>
    Number(
      await page.getByText("Radius", { exact: true }).locator(
        "xpath=following-sibling::div[1]//input",
      ).inputValue(),
    );
  const r0 = await radius();
  await page.mouse.move(...(await screen(-30, -10)));
  await page.keyboard.press("BracketRight");
  assert((await radius()) > r0, "] grows the brush");
  await page.keyboard.press("BracketLeft");
  await page.keyboard.press("BracketLeft");
  assert((await radius()) < r0, "[ shrinks it");
  const mark = (await state()).sum;
  await stroke([-30, -10], [30, 20], ["Control"]);
  await steps(2);
  assert((await state()).sum < mark, "Ctrl lowers on the raise tool");
  assertEquals((await state()).last, "Lower ground");
  await undo();
  {
    const keep = await heights();
    const [ax, ay] = await screen(-30, -10), [bx, by] = await screen(30, 20);
    await page.mouse.move(ax, ay);
    await page.mouse.down();
    await page.mouse.move(bx, by, { steps: 6 });
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await sleep(300);
    assertEquals(await heights(), keep, "Escape put the ground back");
    assertEquals((await state()).steps, 1);
  }
  lap("[ ] resize, Ctrl inverts, Escape cancels");

  // 5. Noise, smooth, Shift, flatten ------------------------------------------------
  const roughness = (h: number[], cx: number, cz: number) => {
    let sum = 0, n = 0;
    for (let z = cz - 10; z < cz + 10; z++) {
      for (let x = cx - 10; x < cx + 10; x++) {
        sum += Math.abs(h[z * 257 + x + 1] - h[z * 257 + x]);
        n++;
      }
    }
    return sum / n;
  };
  const h0 = await heights();
  await tool("terrain-noise");
  await stroke([-60, -40], [-20, -40]);
  await steps(2);
  const h1 = await heights();
  const rough = [roughness(h0, 88, 88), roughness(h1, 88, 88)];
  assert(rough[1] > rough[0] * 1.2, `noise adds relief ${rough}`);
  await tool("terrain-smooth");
  for (let k = 0; k < 3; k++) await stroke([-70, -40], [-10, -40]);
  await steps(5);
  assert(
    roughness(await heights(), 88, 88) < rough[1] * 0.7,
    "smooth relaxes it",
  );
  await tool("terrain-raise");
  await stroke([-70, -40], [-10, -40], ["Shift"]);
  await steps(6);
  assertEquals((await state()).last, "Smooth ground", "Shift smooths");
  await tool("terrain-flatten");
  const [fx, fy] = await screen(50, 50);
  await page.keyboard.down("Control");
  await page.mouse.move(fx, fy);
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up("Control");
  await sleep(300);
  assertEquals((await state()).steps, 6, "sampling a level is not an edit");
  const level = await ink((i) =>
    i.renderer!.assets.terrain("terrain/small.terrain").field!.sampleCell(
      178,
      178,
    )
  );
  const shown = Number(
    await page.getByText("Height", { exact: true }).locator(
      "xpath=following-sibling::div[1]//input",
    ).inputValue(),
  );
  assert(
    Math.abs(shown - level) < 0.01,
    "the sampled level shows in the panel",
  );
  await stroke([-30, 40], [30, 40]);
  await steps(7);
  const flattened = await heights();
  for (const x of [-20, 0, 20]) {
    const v = flattened[(128 + 40) * 257 + 128 + x];
    assert(Math.abs(v - level) < 0.6, `flattened at ${x}: ${v} vs ${level}`);
  }
  for (let n = 6; n >= 1; n--) await undo();
  assertEquals(await heights(), raised, "undoing back to the raise");
  lap("noise, smooth, Shift, flatten: each one step, all undone");

  // 6. Paint ------------------------------------------------------------------------
  await tool("terrain-paint");
  await page.locator('[data-testid="terrain-layer-2"]').click();
  const splat0 = await splat();
  await stroke([-50, 40], [-35, 45]);
  await steps(2);
  const painted = await ink((i) => {
    const f = i.renderer!.assets.terrain("terrain/small.terrain").field!;
    return [0, 1, 2, 3].map((l) => f.splatAt(l, 78, 168));
  });
  assert(painted[2] > 0.4, `layer 2 painted ${painted}`);
  assertEquals(Math.round(painted.reduce((a, b) => a + b, 0) * 255), 255);
  await until(
    async () => (await onDisk()).splat.join() === (await splat()).join(),
    (v) => v,
    "the splat in the file",
  );
  await undo();
  assertEquals(await splat(), splat0);
  lap("paint: weights stay normalised, saved, undone");

  // 7. Scatter ----------------------------------------------------------------------
  await ink((i) => i.session.select([4]));
  await tool("scatter-paint");
  const count = () =>
    ink((i) => i.renderer!.assets.scatter("scatter/trees.scatter").set!.count);
  const c0 = await count();
  await stroke([20, 40], [80, 45]);
  await steps(2);
  const c1 = await count();
  assert(c1 > c0 + 5, `trees were painted ${c0} to ${c1}`);
  assertEquals(
    await ink((i) =>
      i.session.entity(4)!.components.scatter.revision as number
    ),
    1,
  );
  await until(
    async () =>
      ScatterSet.parse(await Deno.readFile(join(dir, "assets", SCATTER))).count,
    (n) => n === c1,
    "the placements in the file",
  );
  await undo();
  assertEquals(await count(), c0);
  await page.keyboard.press("Control+Shift+z");
  await until(count, (n) => n === c1, "the redo");
  await stroke([20, 40], [80, 45], ["Control"]);
  await until(count, (n) => n < c1, "Ctrl to erase");
  lap("scatter: placed, saved, undone, redone, erased");

  // 8. A script rewrites the file: that does reload ---------------------------------
  await until(() => reloads(), (n) => n === 0, "no reloads so far");
  {
    const edited = await onDisk();
    edited.heights.fill(7);
    edited.revision = 99;
    await Deno.writeFile(join(dir, "assets", TERRAIN), edited.serialize());
  }
  await until(() => reloads(), (n) => n >= 1, "the reload of an outside edit");
  await until(
    async () => (await heights())[1000],
    (v) => v === 7,
    "the new heights",
  );
  lap("an outside edit of the file still reloads");

  // 9. A missing collision grid is reported, rebuilt on request ---------------------
  await ink((i) => i.session.select([3]));
  await tool("select");
  await ink((i) =>
    i.session.edit("Empty the grid", (w) => {
      w.entities.find((e) => e.id === 3)!.components.terrain.grid = [];
    })
  );
  await page.waitForSelector('[data-testid="terrain-grid-warning"]');
  await page.getByRole("button", { name: "Rebuild collision grid" }).click();
  await until(
    () =>
      ink((i) =>
        (i.session.entity(3)!.components.terrain.grid as number[]).length
      ),
    (n) => n === 33 * 33,
    "the rebuilt grid",
  );
  assertEquals(
    await page.locator('[data-testid="terrain-grid-warning"]').count(),
    0,
  );
  lap("an empty collision grid is reported and rebuilt on request");

  // 10. New terrain from the panel --------------------------------------------------
  await page.locator('[data-testid="terrain-create"]').scrollIntoViewIfNeeded();
  await page.locator('[data-testid="terrain-create"]').click();
  await until(
    () => ink((i) => i.session.catalog.assets.terrain ?? []),
    (l) => l.length === 2,
    "the new asset in the catalog",
  );
  await until(
    () => ink((i) => i.session.world.entities.length),
    (n) => n === 6,
    "the new entity",
  );
  const made = Heightfield.parse(
    await Deno.readFile(join(dir, "assets/terrain/world.terrain")),
  );
  assertEquals(made.cells, 1024);
  assertEquals(made.layers, 4);
  assertEquals(made.heights.every((h) => h === 0), true);
  lap("a new flat terrain made from the panel");

  if (errors.length) throw new Error(errors.join("\n"));
  console.log("terrain tools ok");
} finally {
  await browser.close();
  await server.close();
  await Deno.remove(dir, { recursive: true }).catch(() => {});
}
