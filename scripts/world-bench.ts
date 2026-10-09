/**
 * How the runtime holds up with thousands of entities (hill 1).
 *
 *   deno run -A scripts/world-bench.ts [--counts 1000,5000,20000]
 *     [--movers 0.2,1]       fractions (or counts) of entities that move; 1 = all
 *     [--frames 90]          steps measured per size
 *     [--check]              assert the 20,000-entity gate (CI)
 *     [--browser] [--hardware] [--headed]   also measure in Chromium
 *
 * Deno runs the real Session over the stress project (`scripts/stress`): guest
 * step, keyframes, rewind, hot reload, schema migration, scene extraction and
 * state hashing. The browser adds the frame loop, React panels and rendering.
 * Results are printed and saved to `tmp/world-bench.json`.
 */
import process from "node:process";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  encodeWorld,
  idleInput,
  type SceneFile,
  sceneToWorld,
} from "@ink/schema";
import type { Catalog } from "@ink/schema";
import { createGameCompiler, formatDiagnostic } from "@ink/blot/compiler";
import { loadGame } from "@ink/blot";
import { runHeadless, Session, stateHash } from "@ink/core";
import { extractScene } from "@ink/render";
import { scanAssets } from "@ink/dev/catalog";
import { resolveProject } from "@ink/dev/node";
import schema, { extended } from "./stress/schema.ts";
import { stressScene } from "./stress/world.ts";

const args = Deno.args;
const option = (name: string, fallback: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const check = args.includes("--check");
const counts = option("counts", check ? "20000" : "1000,5000,20000").split(",")
  .map(Number);
const frames = Number(option("frames", check ? "60" : "90"));
/** Each size with every mover fraction (or count) asked for. */
const cases = counts.flatMap((count) =>
  option("movers", check ? "0.2" : "0.2,1").split(",").map(Number).map((m) => ({
    count,
    movers: m <= 1 ? Math.round(count * m) : m,
  }))
);

/** Milliseconds: wall-clock median, 95th percentile and best, and the
 * median CPU time, which a busy machine disturbs far less. */
export interface Stat {
  median: number;
  p95: number;
  min: number;
  cpu: number;
}
export function stat(times: number[], cpu: number[]): Stat {
  const sorted = (list: number[]) => [...list].sort((a, b) => a - b);
  const s = sorted(times);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(s.length * q))];
  return {
    median: +at(0.5).toFixed(3),
    p95: +at(0.95).toFixed(3),
    min: +s[0].toFixed(3),
    cpu: +sorted(cpu)[Math.floor(cpu.length / 2)].toFixed(3),
  };
}
function measure(n: number, f: () => void, warm = 3): Stat {
  const times: number[] = [];
  const cpu: number[] = [];
  for (let i = 0; i < n + warm; i++) {
    const before = process.cpuUsage();
    const a = performance.now();
    f();
    const wall = performance.now() - a;
    const used = process.cpuUsage(before);
    if (i >= warm) {
      times.push(wall);
      cpu.push((used.user + used.system) / 1000);
    }
  }
  return stat(times, cpu);
}

const project = await resolveProject("scripts/stress");
const catalog: Catalog = await scanAssets(project.assetsDir);

const dir = join(project.dir, "game");
const compiler = await createGameCompiler({
  entry: join(dir, "main.blot"),
  schema,
  catalog,
});
const built = await compiler.build();
if (!built.ok) {
  throw new Error(built.diagnostics.map(formatDiagnostic).join("\n"));
}
const load = () => loadGame(built.bytes, schema);

const results: Record<string, unknown>[] = [];
for (const { count, movers } of cases) {
  const scene: SceneFile = stressScene(count, movers);
  const out: Record<string, unknown> = { count, movers };

  // Building the world and putting it on screen.
  let t = performance.now();
  const loaded = sceneToWorld(schema, scene, catalog);
  out.sceneToWorldMs = +(performance.now() - t).toFixed(1);
  t = performance.now();
  const state = encodeWorld(schema, loaded.world);
  out.encodeMs = +(performance.now() - t).toFixed(1);
  out.lanes = state.length;
  out.megabytes = +(state.byteLength / 1e6).toFixed(2);
  t = performance.now();
  const session = new Session({ schema, catalog, scene });
  session.setGame(await load(), { revision: 1 });
  out.sessionMs = +(performance.now() - t).toFixed(1);
  t = performance.now();
  session.play();
  out.playMs = +(performance.now() - t).toFixed(1);

  // One step: guest call plus the host's packet handling.
  const game = await load();
  const input = idleInput(schema);
  let cursor = state;
  out.guestStep = measure(frames, () => {
    cursor = game.step(cursor, input).state;
  });
  game.dispose();

  // The session's step, as the frame loop drives it.
  out.sessionStep = measure(frames, () => session.stepFrame());

  // What every step costs the things that look at the world.
  out.worldAccess = measure(frames, () => {
    session.stepFrame();
    session.world.entities.length;
    session.structure;
  });
  out.extractScene = measure(Math.min(frames, 30), () => {
    session.stepFrame();
    extractScene(session.world, session.catalog, {
      dt: session.dt,
      events: session.presentationEvents,
    });
  });
  out.stateHash = measure(10, () => stateHash(session.state));

  // Snapshots and rewind: keyframes are the states themselves.
  const keyframes = session.timeline.keyframes.length;
  const tickBefore = session.tick;
  t = performance.now();
  session.seek(tickBefore - Math.min(45, tickBefore));
  out.rewindMs = +(performance.now() - t).toFixed(1);
  out.keyframes = keyframes;
  out.timelineMegabytes = +(session.timeline.bytes / 1e6).toFixed(1);
  t = performance.now();
  session.seek(tickBefore);
  out.replayForwardMs = +(performance.now() - t).toFixed(1);

  // Hot reload: a new guest takes over the live state.
  const before = session.state.slice();
  t = performance.now();
  session.setGame(await load(), { revision: 2 });
  out.hotReloadMs = +(performance.now() - t).toFixed(1);
  assertEquals(session.state, before, "hot reload must keep the state");
  session.stepFrame();

  // Editing the live world while paused (what a drag in a viewport does).
  session.pause();
  const target = session.world.entities[Math.floor(count / 2)].id;
  let nudge = 0;
  out.liveEdit = measure(10, () => {
    session.setComponent(target, "transform", { position: [++nudge, 0, 0] });
  });
  assert(
    session.world.entities.length === count + 3,
    "an edit must keep every entity",
  );
  session.undo();

  // Schema migration: add a component to a running world.
  t = performance.now();
  session.setProject(extended, catalog);
  out.migrationMs = +(performance.now() - t).toFixed(1);
  session.dispose();

  // Determinism: the same ticks from the same scene give the same bytes, in a
  // fresh guest, through a session, and after a rewind.
  const a = runHeadless(await load(), schema, state, 40).state;
  const b = runHeadless(await load(), schema, state, 40).state;
  assertEquals(a, b, "headless runs must be byte-identical");
  const replay = new Session({ schema, catalog, scene });
  replay.setGame(await load(), { revision: 1 });
  replay.play();
  for (let i = 0; i < 40; i++) replay.stepFrame();
  assertEquals(
    stateHash(replay.state),
    stateHash(a),
    "a session must match a headless run",
  );
  replay.seek(17);
  replay.seek(40);
  assertEquals(replay.state, a, "rewinding and replaying must reproduce it");
  out.determinism = `ok ${stateHash(a)}`;
  replay.dispose();
  results.push(out);
  console.log(JSON.stringify(out));
}
await compiler.dispose();

/** A readable summary: wall-clock median / 95th percentile, in milliseconds. */
function table(rows: Record<string, unknown>[]) {
  const pair = (value: unknown) => {
    const v = value as Stat;
    return `${v.median.toFixed(1)} / ${v.p95.toFixed(1)}`;
  };
  console.log(
    [
      "entities",
      "moving",
      "guest step",
      "session step",
      "extract+step",
      "live edit",
      "rewind",
      "hot reload",
      "migrate",
    ].join(" | "),
  );
  for (const r of rows) {
    console.log(
      [
        r.count,
        r.movers,
        pair(r.guestStep),
        pair(r.sessionStep),
        pair(r.extractScene),
        pair(r.liveEdit),
        `${r.rewindMs} ms`,
        `${r.hotReloadMs} ms`,
        `${r.migrationMs} ms`,
      ].join(" | "),
    );
  }
}
table(results);

let browserResults: unknown[] | undefined;
if (args.includes("--browser")) {
  const { measureBrowser } = await import("./stress/browser.ts");
  type BrowserResult = Awaited<ReturnType<typeof measureBrowser>>[number];
  browserResults = await measureBrowser({
    cases,
    frames: Number(option("browser-frames", "30")),
    hardware: args.includes("--hardware"),
    headed: args.includes("--headed"),
  });
  for (
    const row of browserResults as {
      count: number;
      movers: number;
      hash40: string;
    }[]
  ) {
    console.log(JSON.stringify(row));
    const headless = results.find((r) =>
      r.count === row.count && r.movers === row.movers
    )!.determinism;
    assertEquals(
      `ok ${row.hash40}`,
      headless,
      `Chromium and Deno disagree after 40 ticks of ${row.count} entities`,
    );
  }
  const rows = browserResults as unknown as BrowserResult[];
  const spread = (v: Stat | BrowserResult["step"]) =>
    `${v.median.toFixed(1)} / ${v.p95.toFixed(1)}`;
  console.log(`Chromium on ${rows[0]?.adapter.trim()} (median / p95 ms)`);
  console.log(
    "entities | moving | step | extract | panels | render submit | render done | loop steps/s | loop frame | state hash",
  );
  for (const r of rows) {
    console.log(
      [
        r.count,
        r.movers,
        spread(r.step),
        spread(r.extract),
        spread(r.panels),
        spread(r.renderCpu),
        spread(r.renderComplete),
        r.loop.stepsPerSecond,
        spread(r.loop.frameMs),
        `${r.hash40} (matches Deno)`,
      ].join(" | "),
    );
  }
}

await Deno.mkdir("tmp", { recursive: true });
await Deno.writeTextFile(
  "tmp/world-bench.json",
  JSON.stringify({ deno: results, browser: browserResults }, null, 2),
);

if (check) {
  const big = results.find((r) => r.count === 20000);
  assert(big, "--check measures 20,000 entities");
  const step = (big.sessionStep as Stat).median;
  const limit = Number(option("limit", String(1000 / 60)));
  assert(step < limit, `a 20,000-entity step took ${step} ms, limit ${limit}`);
}
