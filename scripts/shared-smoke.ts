/** Two real editors share scene edits/comments/presence, then play that scene. */
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { type Browser, chromium, type Page } from "playwright-core";
import { findChromium, startServer } from "@ink/dev/cli";
import { resolveProject } from "@ink/dev/node";
import { callAutomation } from "../packages/dev/browser.ts";
import type { Ink } from "../packages/react/context.tsx";
import type { SharedSession } from "@ink/core";
import type { InkAutomation } from "@ink/dev/automation";

type Global = { __ink: InkAutomation; [key: symbol]: Promise<{ ink: Ink }> };
await Deno.mkdir("tmp", { recursive: true });
const dir = await Deno.makeTempDir({ dir: "tmp", prefix: "ink-shared-" });
async function copy(from: string, to: string) {
  await Deno.mkdir(to, { recursive: true });
  for await (const e of Deno.readDir(from)) {
    if (
      e.name.startsWith(".") ||
      ["node_modules", "dist", "dist-desktop"].includes(e.name)
    ) continue;
    if (e.isDirectory) await copy(join(from, e.name), join(to, e.name));
    else if (e.isFile) {
      await Deno.copyFile(join(from, e.name), join(to, e.name));
    }
  }
}
await copy("examples/feel", dir);
let server: Awaited<ReturnType<typeof startServer>> | undefined;
let browser: Browser | undefined;
try {
  server = await startServer(await resolveProject(dir), {
    port: 0,
    quiet: true,
  });
  const port = (server.httpServer!.address() as { port: number }).port;
  browser = await chromium.launch({
    executablePath: await findChromium(),
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan=swiftshader",
      "--use-webgpu-adapter=swiftshader",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
    ],
  });
  const errors: string[] = [];
  const pages: Page[] = [];
  for (const name of ["Alice", "Bob"]) {
    const page = await browser.newPage({
      viewport: { width: 1840, height: 1000 },
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(
      `http://127.0.0.1:${port}/?scene=multiplayer&ink-automation`,
    );
    await page.waitForFunction(() => "__ink" in globalThis);
    await callAutomation(page, "ready", undefined);
    await page.getByRole("button", { name: "Share scene", exact: true })
      .click();
    await page.getByRole("textbox", { name: "Your name", exact: true }).fill(
      name,
    );
    await page.getByRole("button", { name: "Join shared scene", exact: true })
      .click();
    await page.waitForFunction(async () =>
      (await (globalThis as unknown as Global)[Symbol.for("ink.boot")]).ink
        .session.documentDriver?.available
    );
    await page.getByRole("dialog", { name: "Shared editing" }).getByRole(
      "button",
      { name: "Close", exact: true },
    ).click();
    pages.push(page);
  }
  const read = (page: Page) =>
    page.evaluate(async () => {
      const { ink } =
        await (globalThis as unknown as Global)[Symbol.for("ink.boot")];
      const shared = ink.session.documentDriver as SharedSession;
      return {
        scene: ink.session.toScene(),
        comments: ink.session.comments,
        selection: ink.session.selection,
        peers: shared?.peers,
        driver: shared?.available,
        history: ink.session.history(),
      };
    });
  const converge = async () => {
    for (let i = 0; i < 80; i++) {
      const states = await Promise.all(pages.map(read));
      if (
        JSON.stringify(states[0].scene) === JSON.stringify(states[1].scene) &&
        JSON.stringify(states[0].comments) ===
          JSON.stringify(states[1].comments)
      ) return states;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("shared documents did not converge");
  };
  console.log("shared peers joined");
  // Edits use the same Session API as inspector gestures and live-agent edits.
  await Promise.all(pages.map((page, i) =>
    page.evaluate(async (i) => {
      const { ink } =
        await (globalThis as unknown as Global)[Symbol.for("ink.boot")];
      ink.session.edit(
        i ? "Bob moves goal Y" : "Alice moves goal X",
        (world) => {
          const goal = world.entities.find((e) => e.components.goal)!;
          (goal.components.transform.position as number[])[i] += i ? 2 : 1;
        },
      );
      const id = ink.session.createEntity({
        name: i ? "Bob's marker" : "Alice's marker",
        components: {
          transform: { position: [i * 2, 3, 0] },
          mesh: {
            shape: "builtin:cube",
            color: i ? [1, 0.4, 0.1, 1] : [0.2, 0.5, 1, 1],
          },
        },
      });
      ink.session.select([id]);
      ink.session.addComment({
        text: `Note from ${i ? "Bob" : "Alice"}`,
        author: i ? "Bob" : "Alice",
        anchor: { mode: "edit", tick: 0, entity: id },
      });
      await ink.session.documentDriver!.flush();
    }, i)
  ));
  let states = await converge();
  assertEquals(
    states[0].scene.entities.filter((e) => e.name?.includes("marker")).length,
    2,
  );
  assertEquals(states[0].comments.length, 2);
  assert(
    states[0].selection[0] !== states[1].selection[0],
    "selections remain personal",
  );
  const id = states[0].comments[0].id;
  await Promise.all(pages.map((page, i) =>
    page.evaluate(async ({ id, i }) => {
      const { ink } =
        await (globalThis as unknown as Global)[Symbol.for("ink.boot")];
      ink.session.replyToComment(id, {
        text: `Concurrent reply ${i}`,
        author: i ? "Bob" : "Alice",
        created: "2026-10-08T00:00:00Z",
      });
      await ink.session.documentDriver!.flush();
    }, { id, i })
  ));
  states = await converge();
  assertEquals(states[0].comments[0].replies?.length, 2);
  // Undo Alice's marker. Bob's marker, edits and comments remain.
  await pages[0].keyboard.press("Control+z");
  states = await converge();
  assertEquals(
    states[0].scene.entities.filter((e) => e.name?.includes("marker")).map((
      e,
    ) => e.name),
    ["Bob's marker"],
  );
  assertEquals(states[0].comments.length, 2);
  await pages[1].evaluate(async () => {
    const { ink } =
      await (globalThis as unknown as Global)[Symbol.for("ink.boot")];
    ink.session.select([16]);
  });
  const camera = (page: Page) =>
    page.evaluate(async () =>
      (await (globalThis as unknown as Global)[Symbol.for("ink.boot")]).ink
        .views.get("level")!.pose()
    );
  const aliceCamera = await camera(pages[0]);
  const level =
    (await pages[1].locator('[data-view-id="level"]').boundingBox())!;
  await pages[1].mouse.move(
    level.x + level.width / 2,
    level.y + level.height / 2,
  );
  await pages[1].mouse.down({ button: "middle" });
  await pages[1].mouse.move(
    level.x + level.width / 2 + 85,
    level.y + level.height / 2 + 15,
    { steps: 8 },
  );
  await pages[1].mouse.up({ button: "middle" });
  assertEquals(
    await camera(pages[0]),
    aliceCamera,
    "Bob's pan leaves Alice's camera unchanged",
  );
  assert(
    JSON.stringify(await camera(pages[1])) !== JSON.stringify(aliceCamera),
  );
  await pages[0].waitForFunction(async () => {
    const { ink } =
      await (globalThis as unknown as Global)[Symbol.for("ink.boot")];
    const peers = (ink.session.documentDriver as SharedSession).peers;
    return JSON.stringify(
      peers.find((p) => p.name === "Bob")?.cameras.level,
    ) !== JSON.stringify(peers.find((p) => p.name === "Alice")?.cameras.level);
  });
  await pages[0].getByRole("button", { name: "2 editing", exact: true })
    .click();
  await pages[0].getByText("Bob", { exact: true }).waitFor();
  await pages[0].screenshot({ path: "tmp/shared-editing.png" });
  await pages[0].getByRole("dialog", { name: "Shared editing" }).getByRole(
    "button",
    { name: "Close", exact: true },
  ).click();
  // Both users play the document they just edited through the rollback room.
  for (const page of pages) {
    await page.getByRole("button", { name: "Multiplayer", exact: true })
      .click();
    await page.getByRole("textbox", { name: "Room", exact: true }).fill(
      "shared-play",
    );
    await page.getByRole("button", { name: "Join room", exact: true }).click();
  }
  for (const page of pages) {
    await page.waitForFunction(() =>
      (globalThis as unknown as Global).__ink.network()?.confirmed! > 20
    );
  }
  await pages[0].getByTitle("Flip to the game (Ctrl+G)", { exact: true })
    .click();
  await pages[0].waitForFunction(() =>
    (globalThis as unknown as Global).__ink.network()?.confirmed! > 40
  );
  assertEquals(
    (await read(pages[0])).driver,
    true,
    "sharing survives a layout switch",
  );
  await pages[0].locator(".ink-viewport").first().focus();
  await pages[0].keyboard.press("Space");
  await pages[0].screenshot({ path: "tmp/shared-play.png" });
  await pages[0].keyboard.press("Control+g");
  await pages[1].getByTitle("Stop (F5)", { exact: true }).click();
  // Reload rejoins the saved CRDT without replacing concurrent changes.
  await pages[1].reload();
  await pages[1].waitForFunction(() => "__ink" in globalThis);
  await callAutomation(pages[1], "ready", undefined);
  await pages[1].getByRole("button", { name: "Share scene", exact: true })
    .click();
  await pages[1].getByRole("button", { name: "Join shared scene", exact: true })
    .click();
  await pages[1].waitForFunction(async () =>
    (await (globalThis as unknown as Global)[Symbol.for("ink.boot")]).ink
      .session.documentDriver?.available
  );
  states = await converge();
  assertEquals(states[1].comments[0].replies?.length, 2);
  assertEquals(
    states[1].scene.entities.filter((e) => e.name?.includes("marker")).map((
      e,
    ) => e.name),
    ["Bob's marker"],
  );
  assertEquals(errors, []);
  console.log(
    "✓ shared edits, independent selections, per-author undo, concurrent comments, presence, shared play and persisted rejoin",
  );
} finally {
  await browser?.close();
  await server?.close();
  await Deno.remove(dir, { recursive: true });
}
