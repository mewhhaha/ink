import { assert, assertEquals } from "@std/assert";
import { percentile, Profiler } from "./profiler.ts";

Deno.test("metrics summarise a rolling window", () => {
  const profiler = new Profiler();
  for (let i = 1; i <= 100; i++) profiler.sample("step", i);
  const step = profiler.metric("step");
  assertEquals(step.samples, 100);
  assertEquals(step.last, 100);
  assertEquals(step.median, 51);
  assertEquals(step.p95, 96);
  assertEquals(step.max, 100);
  assertEquals(profiler.metric("gpu").samples, 0);
});

Deno.test("a trace's stages add up to its total", () => {
  const profiler = new Profiler();
  const start = 1000;
  assert(profiler.begin("a", "code", "game/main.blot", start));
  // Continuing a trace with the same id is not a new one.
  assert(!profiler.begin("a", "code", "game/main.blot", start));
  profiler.mark("watch", 1005);
  profiler.mark("blotc", 1105);
  profiler.mark("wasm", 1115);
  profiler.arm();
  const tick = { start: 1120, stepEnd: 1121, stepped: true, end: 1130 };
  profiler.beginTick();
  profiler.spend("extract", 2);
  profiler.drawn();
  profiler.spend("render", 4);
  assert(profiler.tail(tick));
  profiler.gpuDone(1150);
  profiler.presented(1160);
  const trace = profiler.lastTrace!;
  assertEquals(trace.outcome, "presented");
  assertEquals(trace.total, 160);
  assertEquals(
    trace.stages.reduce((sum, s) => sum + s.ms, 0),
    trace.total,
  );
  const ms = (stage: string) => trace.stages.find((s) => s.stage === stage)!.ms;
  assertEquals(ms("watch"), 5);
  assertEquals(ms("blotc"), 100);
  assertEquals(ms("frame"), 5);
  assertEquals(ms("step"), 1);
  assertEquals(ms("extract"), 2);
  assertEquals(ms("render"), 4);
  assertEquals(ms("gpu"), 20);
  assertEquals(ms("present"), 10);
  assertEquals(profiler.snapshot().latest.code?.id, "a");
});

Deno.test("a tick that drew nothing does not end an armed trace", () => {
  const profiler = new Profiler();
  profiler.begin("b", "tuning", "x", 0);
  profiler.arm();
  profiler.beginTick();
  assertEquals(
    profiler.tail({ start: 1, stepEnd: 1, stepped: false, end: 2 }),
    false,
  );
  assert(profiler.armed);
  profiler.beginTick();
  profiler.drawn();
  assert(profiler.tail({ start: 3, stepEnd: 3, stepped: false, end: 4 }));
});

Deno.test("measure skips while another trace is open and rate limits", () => {
  const profiler = new Profiler();
  let runs = 0;
  profiler.measure("tuning", "a", () => runs++);
  assert(profiler.armed);
  profiler.measure("tuning", "b", () => runs++);
  assertEquals(runs, 2);
  assertEquals(profiler.pending?.file, "a");
});

Deno.test("an unchanged or failed build ends its trace without pixels", () => {
  const profiler = new Profiler();
  profiler.begin("c", "code", "f", 0);
  profiler.mark("blotc", 10);
  profiler.end("unchanged");
  assertEquals(profiler.lastTrace?.outcome, "unchanged");
  assertEquals(profiler.snapshot().latest.code, undefined);
});

Deno.test("percentile", () => {
  assertEquals(percentile([], 0.5), 0);
  assertEquals(percentile([5, 1, 3], 0.5), 3);
});
