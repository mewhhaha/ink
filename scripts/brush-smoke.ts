/** Exercise the real brush tools with pointer/key events in Hammer. */
import { chromium, type Page } from "playwright-core";
import { assert, assertEquals } from "@std/assert";
import { boxBrush, quat, type Vec3 } from "@ink/geometry";
import type { SceneFile } from "@ink/schema";
import type { Ink } from "../packages/react/context.tsx";
import type { InkAutomation } from "@ink/dev/automation";
import { startServer } from "@ink/dev/cli";
import { resolveProject } from "@ink/dev/node";

type Global = {
  __ink: InkAutomation;
  __brushClip: { get(): { points: number } };
  [key: symbol]: Promise<{ ink: Ink }>;
};
const root = new URL("../", import.meta.url).pathname;
const fixture: SceneFile = {
  ink: 1,
  entities: [
    {
      id: 1,
      name: "Parent",
      components: {
        transform: {
          rotation: quat.fromEuler([0, 30, 0]),
          scale: [1.5, 1, 0.8],
        },
      },
    },
    {
      id: 2,
      parent: 1,
      name: "Nested brush",
      components: {
        transform: {},
        brush: { faces: boxBrush([-1, -1, -1], [1, 1, 1]) },
      },
    },
    {
      id: 3,
      name: "Other brush",
      components: {
        transform: { position: [6, 0, 0] },
        brush: { faces: boxBrush([-1, -1, -1], [1, 1, 1]) },
      },
    },
  ],
};
const server = await startServer(await resolveProject("examples/hammer"), {
  port: 0,
  quiet: true,
});
const address = server.httpServer!.address() as { port: number };
const browser = await chromium.launch({
  executablePath: Deno.env.get("INK_CHROMIUM") ??
    `${
      Deno.env.get("HOME")
    }/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,
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
const errors: string[] = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/?ink-automation`);
  await page.waitForFunction(() => "__ink" in globalThis);
  await page.evaluate(() => (globalThis as unknown as Global).__ink.ready);
  await page.evaluate(async (root) => {
    const { clipState } = await import(`/@fs${root}packages/brushes/state.ts`);
    (globalThis as unknown as Global).__brushClip = clipState;
  }, root);
  const reset = async () => {
    await page.evaluate(async (state) => {
      await (globalThis as unknown as Global).__ink.run({ state, ticks: 0 });
    }, fixture);
    await page.waitForFunction(() =>
      document.querySelectorAll(".ink-viewport canvas").length === 4
    );
  };
  const select = async (ids: number[]) =>
    await page.evaluate(async (ids) => {
      const { ink } =
        await (globalThis as unknown as Global)[Symbol.for("ink.boot")];
      ink.session.select(ids);
    }, ids);
  const selection = () =>
    page.evaluate(async () => {
      const { ink } =
        await (globalThis as unknown as Global)[Symbol.for("ink.boot")];
      return [...ink.session.selection];
    });
  const state = () =>
    page.evaluate(() => (globalThis as unknown as Global).__ink.state());
  const point = async (
    view: string,
    world: Vec3,
  ): Promise<[number, number]> => {
    const xy = await page.evaluate(async ({ view, world }) => {
      const { ink } =
        await (globalThis as unknown as Global)[Symbol.for("ink.boot")];
      return ink.views.get(view)!.project(world);
    }, { view, world });
    assert(xy, "point projects into the viewport");
    const bounds = await page.locator(`[data-view-id="${view}"]`).boundingBox();
    assert(bounds);
    return [bounds.x + xy[0], bounds.y + xy[1]];
  };
  const drag = async (page: Page, a: [number, number], b: [number, number]) => {
    await page.mouse.move(...a);
    await page.mouse.down();
    await page.mouse.move(...b, { steps: 6 });
    await page.mouse.up();
  };
  await reset();
  await select([]);
  await page.keyboard.press("q");
  const a = await point("top", [-2.5, 0, -2.5]);
  const b = await point("top", [2.5, 0, 2.5]);
  await drag(page, [Math.min(a[0], b[0]), Math.min(a[1], b[1])], [
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
  ]);
  assert((await selection()).includes(2), "marquee selects the nested brush");
  assert(
    !(await selection()).includes(3),
    "marquee excludes the distant brush",
  );
  await select([2]);
  await page.keyboard.press("v");
  const bounds = await page.evaluate(async (root) => {
    const { ink } =
      await (globalThis as unknown as Global)[Symbol.for("ink.boot")];
    const { brushWorldBounds } = await import(
      `/@fs${root}packages/brushes/edit.ts`
    );
    return brushWorldBounds({
      matrix: ink.scene().matrices.get(2)!,
      faces: ink.session.entity(2)!.components.brush.faces,
    });
  }, root);
  const edge = await point("top", [bounds.max[0], 0, 0]);
  await page.mouse.move(...edge);
  await page.waitForFunction(() =>
    (document.querySelector('[data-view-id="top"]') as HTMLElement)?.style
      .cursor === "ew-resize"
  );
  const before = await state();
  await drag(page, edge, [edge[0] + 40, edge[1]]);
  const after = await state();
  assert(
    JSON.stringify(before.entities[1].components.brush) !==
      JSON.stringify(after.entities[1].components.brush),
    "resize changed faces",
  );
  assertEquals(
    after.entities[1].components.transform,
    before.entities[1].components.transform,
  );
  await page.keyboard.press("Control+z");
  assertEquals(
    (await state()).entities,
    before.entities,
    "one undo restores the resize",
  );
  await page.keyboard.press("j");
  const vertex = await page.evaluate(async () => {
    const { ink } =
      await (globalThis as unknown as Global)[Symbol.for("ink.boot")];
    const m = ink.scene().matrices.get(2)!;
    return [
      m[0] + m[8] + m[12],
      m[1] + m[9] + m[13],
      m[2] + m[10] + m[14],
    ] as Vec3;
  });
  const handle = await point("top", vertex);
  await drag(page, handle, [handle[0] + 30, handle[1] + 20]);
  assert(
    JSON.stringify((await state()).entities[1].components.brush) !==
      JSON.stringify(before.entities[1].components.brush),
    "vertex tool changed faces",
  );
  await page.keyboard.press("Control+z");
  assertEquals(
    (await state()).entities,
    before.entities,
    "one undo restores the vertex edit",
  );
  await page.keyboard.press("x");
  const p = await point("top", [0, 0, -2]);
  const q = await point("top", [0, 0, 2]);
  await page.mouse.click(...p);
  await page.mouse.click(...q);
  await page.keyboard.press("Enter");
  assert(
    JSON.stringify((await state()).entities[1].components.brush) !==
      JSON.stringify(before.entities[1].components.brush),
    "clip cuts the nested brush",
  );
  await page.keyboard.press("Control+z");
  const cutPoints = await page.evaluate(async () => {
    const { ink } =
      await (globalThis as unknown as Global)[Symbol.for("ink.boot")];
    const m = ink.scene().matrices.get(2)!;
    // Two visible front-face points and one on the top cut off the top/front
    // corner; the narrow +X face is almost edge-on to the default camera.
    return [[-0.2, 0.4, 1], [0.5, 0.4, 1], [0.2, 1, 0.4]].map(([x, y, z]) =>
      [
        m[0] * x + m[4] * y + m[8] * z + m[12],
        m[1] * x + m[5] * y + m[9] * z + m[13],
        m[2] * x + m[6] * y + m[10] * z + m[14],
      ] as Vec3
    );
  });
  await page.keyboard.down("Control");
  for (const [index, world] of cutPoints.entries()) {
    await page.mouse.click(...await point("persp", world));
    await page.waitForFunction(
      (count) =>
        (globalThis as unknown as Global).__brushClip.get().points === count,
      index + 1,
    );
  }
  await page.keyboard.up("Control");
  await page.keyboard.press("Enter");
  assert(
    JSON.stringify((await state()).entities[1].components.brush) !==
      JSON.stringify(before.entities[1].components.brush),
    "3D clip cuts the nested brush",
  );
  await Deno.mkdir(`${root}tmp`, { recursive: true });
  await page.screenshot({ path: `${root}tmp/brush-tools.png` });
  assertEquals(errors, []);
  console.log(
    "✓ marquee, transformed resize, vertex edit, 2D/3D clipping and undo in Chromium",
  );
} finally {
  await browser.close();
  await server.close();
}
