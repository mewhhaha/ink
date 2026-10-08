/** A remote agent fixes a replayable report in the person's open editor. */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { chromium } from "playwright-core";
import { findChromium, startServer } from "@ink/dev/cli";
import { resolveProject } from "@ink/dev/node";
import type { LiveSessionInfo } from "@ink/dev/live";
import { type Comment, type Scenario, scenarioInputs } from "@ink/core";
import type { SceneFile } from "@ink/schema";
import schema from "../examples/feel/schema.ts";

await Deno.mkdir("tmp", { recursive: true });
const dir = await Deno.makeTempDir({ dir: "tmp", prefix: "ink-live-" });
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
await copy("examples/feel", dir);
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
const port = (server.httpServer!.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
type World = {
  state: SceneFile;
  status: { kind: string; revision: number };
  views: { id: string }[];
};
async function request(
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(
    base + "/__ink/" + path,
    body === undefined ? undefined : {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
  );
  const value = await response.json();
  if (!response.ok) throw new Error(value.error);
  return value;
}
let session: string;
const call = (
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> => request("live/call", { session, method, params });
const world = () => call("world") as Promise<World>;
async function mcp(name: string, args: Record<string, unknown>) {
  const response = await request("mcp", {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "tools/call",
    params: { name: `ink_${name}`, arguments: { session, ...args } },
  }, {
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-11-25",
  });
  assert(!response.error, JSON.stringify(response));
  assert(!response.result.isError, JSON.stringify(response.result));
  return response.result;
}
async function until<T>(
  get: () => Promise<T>,
  check: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const value = await get();
    if (check(value)) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out waiting for the live editor");
}
const y = (state: SceneFile) =>
  (state.entities.find((e) => e.components.runner)!.components.transform as {
    position: number[];
  }).position[1];
try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  const sessions: LiveSessionInfo[] = await until(
    () => request("live/sessions"),
    (s) => s.length === 1,
  );
  session = sessions[0].id;
  await until(world, (w) => w.views.length > 0 && w.status.kind === "ready");
  assertEquals(
    await page.evaluate(() => "__ink" in globalThis),
    false,
    "ordinary editor needs no automation URL",
  );
  const init = await request("mcp", {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "smoke", version: "1" },
    },
  });
  assertEquals(init.result.protocolVersion, "2025-11-25");
  await assertRejects(
    () =>
      request("live/call", { method: "world" }, {
        Origin: "https://unrelated.example",
      }),
    Error,
    "origin",
  );
  const initial = await world();
  const runner = initial.state.entities.find((e) => e.components.runner)!;
  await assertRejects(
    () =>
      call("edit", {
        entity: runner.id,
        component: "runner",
        values: { typo: 9 },
      }),
    Error,
    "unknown field",
  );
  await call("edit", {
    entity: runner.id,
    component: "runner",
    values: { jump_speed: 20 },
  });
  await call("play", { action: "undo" });
  assertEquals((await world()).state, initial.state);
  const source = await call("source", { path: "game/main.blot" }) as {
    text: string;
    hash: string;
  };
  const broken = source.text.replace("v.y := r.jump_speed", "v.y := 0.0");
  assert(broken !== source.text);
  const changed = await call("source", {
    path: "game/main.blot",
    text: broken,
    expectedHash: source.hash,
  }) as { hash: string };
  const badBuild = await until(
    world,
    (w) =>
      w.status.kind === "ready" && w.status.revision > initial.status.revision,
  );
  await assertRejects(
    () =>
      call("source", {
        path: "game/main.blot",
        text: source.text,
        expectedHash: source.hash,
      }),
    Error,
    "source changed",
  );
  const scenario: Scenario = JSON.parse(
    await Deno.readTextFile(join(dir, "scenarios/jump.scenario.json")),
  );
  const inputs = scenarioInputs({ schema, dt: 1 / 60 }, scenario).slice(0, 72);
  const bad = await call("step", { inputs }) as World;
  assert(y(bad.state) < 1.5);
  const report = await call("comment", {
    action: "add",
    author: "playtester",
    assignee: "agent",
    text: "Jump does not leave the ground",
    anchor: {
      entity: runner.id,
      entityName: "Runner",
      range: { from: 60, to: 72 },
      code: { file: "game/main.blot", line: 65 },
    },
  }) as Comment;
  assert(report.handoff);
  const reproduced = await call("handoff", {
    action: "replay",
    id: report.handoff,
  }) as World;
  assertEquals(
    reproduced.state,
    bad.state,
    "replay reproduces the report exactly",
  );
  const beforeResult = await mcp("capture", { view: "game" });
  assert(
    beforeResult.content.some((c: { type: string }) => c.type === "image"),
  );
  const before = JSON.parse(beforeResult.content[0].text);
  await call("comment", {
    action: "update",
    id: report.id,
    status: "in_progress",
  });
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  await page.getByText(report.text, { exact: true }).waitFor();
  await mcp("source", {
    path: "game/main.blot",
    text: source.text,
    expectedHash: changed.hash,
  });
  await until(
    world,
    (w) =>
      w.status.kind === "ready" && w.status.revision > badBuild.status.revision,
  );
  const fixed = await call("handoff", {
    action: "replay",
    id: report.handoff,
  }) as World;
  assertEquals(fixed.state.tick, 72);
  assert(y(fixed.state) > 1.5, "the corrected jump rises during replay");
  const afterResult = await mcp("capture", { view: "game" });
  const after = JSON.parse(afterResult.content[0].text);
  assert(
    beforeResult.content[1].data !== afterResult.content[1].data,
    "before and after frames differ",
  );
  await mcp("comment", {
    action: "reply",
    id: report.id,
    author: "agent",
    text:
      "Restored the jump impulse and verified the recorded input at tick 72.",
    captures: [{ ...before, label: "before" }, { ...after, label: "after" }],
  });
  await call("comment", {
    action: "update",
    id: report.id,
    status: "resolved",
  });
  assertEquals(
    (await call("comments", { assignee: "agent" }) as Comment[]).length,
    0,
  );
  await page.getByLabel("Filter comments", { exact: true }).selectOption("all");
  await page.getByAltText("before at tick 72").waitFor();
  await page.getByAltText("after at tick 72").waitFor();
  assertEquals(
    await page.getByLabel("Comment status", { exact: true }).inputValue(),
    "resolved",
  );
  const saved: Comment[] = JSON.parse(
    await Deno.readTextFile(join(dir, ".ink/comments.json")),
  );
  assertEquals(saved[0].status, "resolved");
  assertEquals(saved[0].replies?.[0].captures?.length, 2);
  await Deno.mkdir("tmp", { recursive: true });
  await page.screenshot({ path: "tmp/live-agent-workflow.png" });
  // Reports can also originate from the timeline and compiler overlay.
  await page.getByRole("dialog", { name: "Comment queue" }).getByRole(
    "button",
    { name: "Close", exact: true },
  ).click();
  await page.getByRole("button", { name: "Comment range", exact: true })
    .click();
  const rangeDialog = page.getByRole("dialog", {
    name: "Comment on timeline range",
  });
  await rangeDialog.getByLabel("From tick").fill("60");
  await rangeDialog.getByLabel("Range comment").fill(
    "Verify the launch frames",
  );
  await rangeDialog.getByRole("button", { name: "Save comment", exact: true })
    .click();
  await rangeDialog.waitFor({ state: "hidden" });
  await page.getByText("Verify the launch frames", { exact: true }).waitFor();
  const rangeReport = (await call("comments") as Comment[]).find((c) =>
    c.text === "Verify the launch frames"
  )!;
  assertEquals(rangeReport.anchor.range, { from: 60, to: 72 });
  assert(rangeReport.handoff);
  await page.getByRole("dialog", { name: "Comment queue" }).getByRole(
    "button",
    { name: "Close", exact: true },
  ).click();
  const goodSource = await call("source", { path: "game/main.blot" }) as {
    hash: string;
    text: string;
  };
  const invalidSource = await call("source", {
    path: "game/main.blot",
    expectedHash: goodSource.hash,
    text: goodSource.text + "\nconst broken = missing_symbol\n",
  }) as { hash: string };
  await until(world, (w) => w.status.kind === "error");
  await page.getByRole("button", { name: "Comment on diagnostic", exact: true })
    .first().click();
  const diagnostic = await until(
    () => call("comments") as Promise<Comment[]>,
    (cs) => cs.some((c) => c.anchor.code && c.id !== report.id),
  );
  assert(diagnostic.some((c) => c.anchor.code?.file === "game/main.blot"));
  await call("source", {
    path: "game/main.blot",
    expectedHash: invalidSource.hash,
    text: goodSource.text,
  });
  await until(world, (w) => w.status.kind === "ready");
  // Work through the queue and persist capture evidence on every resolution.
  for (const item of await call("comments") as Comment[]) {
    await call("comment", {
      action: "update",
      id: item.id,
      assignee: "agent",
      status: "in_progress",
    });
    await call("comment", {
      action: "reply",
      id: item.id,
      text: "Verified after restoring the jump code.",
      captures: [{ ...after, label: "after" }],
    });
    await call("comment", {
      action: "update",
      id: item.id,
      status: "resolved",
    });
  }
  assertEquals(await call("comments"), []);
  const resolved = JSON.parse(
    await Deno.readTextFile(join(dir, ".ink/comments.json")),
  ) as Comment[];
  assertEquals(resolved.length, 3);
  assert(
    resolved.every((c) =>
      c.status === "resolved" && c.replies?.some((r) => r.captures?.length)
    ),
  );
  const other = await browser.newPage();
  await other.goto(base);
  await until(() => request("live/sessions"), (s) => s.length === 2);
  await assertRejects(
    () => request("live/call", { method: "play", params: { action: "stop" } }),
    Error,
    "several editors",
  );
  assertEquals(
    (await world()).state.tick,
    72,
    "ambiguous commands do not mutate any editor",
  );
  await other.close();
  assertEquals(errors, []);
  console.log(
    "✓ HTTP and MCP: read, edit/undo, replay, code fix, live rebuild, before/after proof, resolved queue, session isolation",
  );
} finally {
  await browser.close();
  await server.close();
  await Deno.remove(dir, { recursive: true });
}
