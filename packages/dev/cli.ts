/** `deno task ink <command> <project> ...` */
import { parseArgs } from "node:util";
import { dirname, join, resolve } from "@std/path";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import {
  decodeWorld,
  encodeWorld,
  type InputModel,
  type SceneFile,
  sceneToWorld,
  worldToScene,
} from "@ink/schema";
import { createGameCompiler, formatDiagnostic } from "@ink/blot/compiler";
import { loadGame } from "@ink/blot";
import { eventText, runHeadless as runSteps } from "@ink/core";
import { ink } from "./plugin.ts";
import { loadSchema, type ResolvedProject, resolveProject } from "./node.ts";
import { scanAssets } from "./catalog.ts";
import { makeId, resolveInside, stableJson } from "./paths.ts";
import { listScenarios, loadScenario } from "./scenarios.ts";
import type { CaptureResult, InkAutomation } from "./automation.ts";

type InkGlobal = { __ink?: InkAutomation };

const USAGE = `usage: deno task ink <command> <project> [options]

  dev <project> [--port N] [--host]
  gen <project>
  check <project>
  test <project> [--scenario name] [--update]
  run <project> [--scene main] [--ticks 60] [--inputs inputs.json] [--out out.scene.json]
  capture <project> [--scene name | --state file | --handoff id]
          [--view game|editor|top|front|side|iso[,...]] [--size 1280x720]
          [--ticks N] [--out file.png] [--url http://...]
  comments <project>
  handoffs <project> [--latest]
`;

export async function startServer(
  project: ResolvedProject,
  options: { port?: number; host?: boolean; quiet?: boolean } = {},
): Promise<ViteDevServer> {
  const user = project.config.vite ?? {};
  const server = await createServer({
    ...user,
    root: project.dir,
    // Deno projects need not have a package.json. Vite otherwise finds an
    // ancestor's node_modules and shares its cache with unrelated projects.
    cacheDir: user.cacheDir ?? join(project.inkDir, "vite"),
    configFile: false,
    logLevel: options.quiet ? "error" : user.logLevel,
    plugins: [
      react(),
      ink(project.dir, project.config),
      ...(user.plugins ?? []),
    ],
    server: {
      ...user.server,
      port: options.port ?? user.server?.port,
      // An explicit port must be that port; a silent fallback sends tools
      // and people to whatever else is listening there.
      strictPort: options.port !== undefined && options.port !== 0,
      host: options.host ? true : user.server?.host ?? "127.0.0.1",
    },
  });
  await server.listen();
  return server;
}

async function compile(project: ResolvedProject) {
  const schema = await loadSchema(project.schemaPath, Date.now());
  const catalog = await scanAssets(project.assetsDir);
  const compiler = await createGameCompiler({
    entry: project.gamePath,
    schema,
    catalog,
  });
  return { schema, catalog, compiler, build: await compiler.build() };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await Deno.readTextFile(path)) as T;
}

async function runHeadless(
  project: ResolvedProject,
  values: Record<string, string | boolean | undefined>,
) {
  const { schema, catalog, compiler, build } = await compile(project);
  try {
    if (!build.ok) {
      console.error(build.diagnostics.map(formatDiagnostic).join("\n"));
      Deno.exit(1);
    }
    const game = await loadGame(build.bytes, schema);
    const sceneName = values.state
      ? String(values.state)
      : String(values.scene ?? "main");
    const scene = await readJson<SceneFile>(
      values.state
        ? String(values.state)
        : join(project.scenesDir, `${sceneName}.scene.json`),
    );
    const loaded = sceneToWorld(schema, scene, catalog);
    for (const problem of loaded.problems) console.error(`scene: ${problem}`);
    const ticks = values.inputs ? undefined : Number(values.ticks ?? 60);
    const inputs = values.inputs
      ? await readJson<InputModel[]>(String(values.inputs))
      : ticks!;
    // The host owns the tick; core's runner advances it as a session does.
    const run = runSteps(
      game,
      schema,
      encodeWorld(schema, loaded.world),
      inputs,
      {
        // A fresh scene (tick 0) starts play; a mid-play state (a hand-off taken
        // while playing) continues where it was.
        start: game.hasStart && loaded.world.tick === 0,
      },
    );
    const state = run.state;
    const events = run.events.flatMap(({ tick, events }) =>
      events.map((e) =>
        `[${tick}] ${e.name}: ${
          eventText(schema, e) ?? JSON.stringify(e.value)
        }`
      )
    );
    const world = decodeWorld(schema, state);
    console.log(
      `${sceneName}: ran to tick ${world.tick}, ${world.entities.length} entities`,
    );
    console.log(`resources ${JSON.stringify(world.resources)}`);
    console.log(events.length ? `events (${events.length}):` : "events: none");
    for (const line of events.slice(0, 50)) console.log(`  ${line}`);
    if (events.length > 50) console.log(`  ... ${events.length - 50} more`);
    if (values.out) {
      const out = worldToScene(schema, world, loaded.names, catalog);
      await Deno.writeTextFile(String(values.out), stableJson(out));
      console.log(`wrote ${values.out}`);
    }
    game.dispose();
  } finally {
    await compiler.dispose();
  }
}

// ---- capture ----------------------------------------------------------------

export async function findChromium(): Promise<string> {
  const env = Deno.env.get("INK_CHROMIUM");
  if (env) return env;
  const root = join(Deno.env.get("HOME") ?? "", ".cache/ms-playwright");
  const found: string[] = [];
  try {
    for await (const e of Deno.readDir(root)) {
      if (/^chromium-\d+$/.test(e.name)) found.push(e.name);
    }
  } catch {
    // fall through
  }
  found.sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  for (const name of found) {
    const path = join(root, name, "chrome-linux64/chrome");
    try {
      await Deno.stat(path);
      return path;
    } catch {
      // try the next
    }
  }
  throw new Error(
    "no Chromium found; set INK_CHROMIUM or run `npx playwright install chromium`",
  );
}

function freePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

async function testScenarios(
  project: ResolvedProject,
  values: Record<string, string | boolean | undefined>,
) {
  const names = values.scenario
    ? [String(values.scenario)]
    : await listScenarios(project);
  if (!names.length) throw new Error("no .scenario.json files in scenarios/");
  const { chromium } = await import("playwright-core");
  const executablePath = await findChromium();
  const server = await startServer(project, { port: 0, quiet: true });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let failed = 0;
  try {
    browser = await chromium.launch({
      executablePath,
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
    const page = await browser.newPage({
      viewport: { width: 1600, height: 900 },
    });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const address = server.httpServer!.address() as { port: number };
    await page.goto(`http://127.0.0.1:${address.port}/?ink-automation`);
    await page.waitForFunction(
      () => !!(globalThis as unknown as InkGlobal).__ink,
      null,
      { timeout: 60000 },
    );
    await page.evaluate(() =>
      (globalThis as unknown as InkGlobal).__ink!.ready
    );
    for (const name of names) {
      const scenario = await loadScenario(project, name);
      const result = await page.evaluate(
        (options) =>
          (globalThis as unknown as InkGlobal).__ink!.scenario(options),
        { scenario, updateGoldens: !!values.update },
      );
      if (errors.length) throw new Error(errors.join("\n"));
      const dir = join(project.inkDir, "scenario-results", name);
      await Deno.mkdir(dir, { recursive: true });
      const writePng = async (path: string, png: string) => {
        await Deno.mkdir(dirname(path), { recursive: true });
        await Deno.writeFile(
          path,
          Uint8Array.from(atob(png.split(",")[1]), (c) => c.charCodeAt(0)),
        );
      };
      for (const frame of result.images) {
        await writePng(join(dir, `${frame.tick}.actual.png`), frame.png);
        if (frame.diff) {
          await writePng(join(dir, `${frame.tick}.diff.png`), frame.diff);
        }
        if (values.update && result.passed) {
          await writePng(
            resolveInside(join(project.dir, "scenarios"), frame.golden),
            frame.png,
          );
        }
      }
      await Deno.writeTextFile(
        join(dir, "result.json"),
        JSON.stringify(
          result,
          (key, value) => key === "png" || key === "diff" ? undefined : value,
          2,
        ) + "\n",
      );
      if (!result.passed) failed++;
      console.log(
        `${result.passed ? "✓" : "✗"} ${name} · tick ${result.tick}${
          values.update && result.passed ? " · goldens updated" : ""
        }`,
      );
      for (const failure of result.failures) {
        console.error(`  tick ${failure.tick}: ${failure.message}`);
      }
    }
  } finally {
    await browser?.close();
    await server.close();
  }
  if (failed) {
    throw new Error(`${failed} scenario(s) failed; see .ink/scenario-results/`);
  }
}

async function capture(
  project: ResolvedProject,
  values: Record<string, string | boolean | undefined>,
) {
  const { chromium } = await import("playwright-core");
  let server: ViteDevServer | undefined;
  let base = values.url ? String(values.url) : "";
  if (!base) {
    server = await startServer(project, {
      port: freePort(),
      quiet: true,
    });
    base = `http://127.0.0.1:${server.config.server.port}/`;
  }
  const views = String(values.view ?? "game").split(",").map((v) => v.trim());
  const [width, height] = String(values.size ?? "1280x720").split("x").map(
    Number,
  );
  const state = values.state
    ? await readJson<SceneFile>(String(values.state))
    : undefined;
  const id = makeId();
  const outDir = join(project.inkDir, "captures", id);
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
  try {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") console.error(`console: ${m.text()}`);
    });
    const target = new URL(base);
    target.searchParams.set("ink-automation", "");
    await page.goto(target.href.replace("ink-automation=", "ink-automation"));
    await page.waitForFunction(
      () => (globalThis as unknown as InkGlobal).__ink !== undefined,
      null,
      { timeout: 30000 },
    );
    await page.evaluate(() =>
      (globalThis as unknown as InkGlobal).__ink!.ready
    );
    for (const view of views) {
      const options = {
        scene: values.scene ? String(values.scene) : undefined,
        state,
        handoff: values.handoff ? String(values.handoff) : undefined,
        ticks: values.ticks === undefined ? undefined : Number(values.ticks),
        view,
        width,
        height,
        quality: values.quality === "high" || values.quality === "low"
          ? values.quality as "high" | "low"
          : undefined,
      };
      const result: CaptureResult = await page.evaluate(
        (o) => (globalThis as unknown as InkGlobal).__ink!.capture(o),
        options,
      );
      // The automation bridge can survive a crashed React tree. A PNG alone
      // is not proof that the editor booted successfully.
      if (errors.length) {
        throw new Error(`capture failed: ${errors.join("; ")}`);
      }
      const png = Uint8Array.from(
        atob(result.png.slice(result.png.indexOf(",") + 1)),
        (c) => c.charCodeAt(0),
      );
      let file = join(outDir, `${view}.png`);
      if (values.out) {
        const out = resolve(String(values.out));
        file = views.length === 1
          ? out
          : out.replace(/(\.png)?$/, `-${view}.png`);
      }
      await Deno.mkdir(dirname(file), { recursive: true });
      await Deno.writeFile(file, png);
      const info = {
        ...options,
        state: state ? "(inline)" : undefined,
        tick: result.tick,
        rendered: result.view,
      };
      await Deno.writeTextFile(
        file.replace(/\.png$/, ".json"),
        stableJson(info),
      );
      console.log(file);
    }
  } finally {
    await browser.close();
    await server?.close();
  }
}

// ---- other commands -----------------------------------------------------------

async function main(argv: string[]) {
  const [command, dir, ...rest] = argv;
  if (!command || !dir || command === "help" || command === "--help") {
    console.log(USAGE);
    Deno.exit(command ? 0 : 1);
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      port: { type: "string" },
      host: { type: "boolean" },
      scene: { type: "string" },
      ticks: { type: "string" },
      inputs: { type: "string" },
      out: { type: "string" },
      state: { type: "string" },
      handoff: { type: "string" },
      view: { type: "string" },
      size: { type: "string" },
      quality: { type: "string" },
      url: { type: "string" },
      latest: { type: "boolean" },
      scenario: { type: "string" },
      update: { type: "boolean" },
    },
  });
  const project = await resolveProject(dir);

  switch (command) {
    case "test":
      await testScenarios(project, values);
      return;
    case "dev": {
      const server = await startServer(project, {
        port: values.port ? Number(values.port) : undefined,
        host: values.host,
      });
      server.printUrls();
      return "keep-alive";
    }
    case "gen": {
      const schema = await loadSchema(project.schemaPath, Date.now());
      const catalog = await scanAssets(project.assetsDir);
      const compiler = await createGameCompiler({
        entry: project.gamePath,
        schema,
        catalog,
      });
      await compiler.dispose();
      console.log(compiler.generatedPath);
      console.log(compiler.generatedTypeScriptPath);
      return;
    }
    case "check": {
      const { compiler, build } = await compile(project);
      await compiler.dispose();
      if (build.ok) {
        console.log(`ok ${Math.round(build.ms)}ms`);
        return;
      }
      console.error(build.diagnostics.map(formatDiagnostic).join("\n"));
      Deno.exit(1);
      return;
    }
    case "run":
      return await runHeadless(project, values);
    case "capture":
      return await capture(project, values);
    case "comments": {
      const comments = await readJson<{ resolved?: boolean }[]>(
        join(project.inkDir, "comments.json"),
      ).catch(() => []);
      const open = comments.filter((c) => !c.resolved);
      console.log(
        open.length ? JSON.stringify(open, null, 2) : "no open comments",
      );
      return;
    }
    case "handoffs": {
      const root = join(project.inkDir, "handoffs");
      const ids: string[] = [];
      try {
        for await (const e of Deno.readDir(root)) {
          if (e.isDirectory) ids.push(e.name);
        }
      } catch {
        // none yet
      }
      ids.sort();
      if (!values.latest) {
        console.log(ids.length ? ids.join("\n") : "no handoffs");
        return;
      }
      const latest = ids.at(-1);
      if (!latest) {
        console.log("no handoffs");
        return;
      }
      const file = join(root, latest, "handoff.md");
      console.log(file);
      console.log(await Deno.readTextFile(file).catch(() => "(no handoff.md)"));
      return;
    }
    default:
      console.error(`unknown command: ${command}\n\n${USAGE}`);
      Deno.exit(1);
  }
}

if (import.meta.main) {
  try {
    const result = await main(Deno.args);
    if (result !== "keep-alive") Deno.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    Deno.exit(1);
  }
}
