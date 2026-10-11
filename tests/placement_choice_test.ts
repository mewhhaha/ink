import { assert, assertEquals } from "@std/assert";
import { compile } from "./support.ts";
const fixture = await compile(
  new URL("./placement_choice.blot", import.meta.url),
);
function next(state: number) {
  if (state === 0) state = 2654435769;
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return state >>> 0;
}
function choose(weights: number[], seed: number) {
  return Array.from(
    fixture.guest.call(
      "choose",
      new Float32Array([seed & 0xffff, seed >>> 16, ...weights]),
    ) as Uint32Array,
  );
}
function reference(weights: number[], seed: number) {
  weights = weights.map(Math.fround);
  if (
    weights.length === 0 || weights.some((v) => v < 0 || !Number.isFinite(v))
  ) return [];
  const largest = Math.max(...weights);
  if (largest === 0) return [];
  const scaled = weights.map((v) => Math.fround(v / largest));
  const total = scaled.reduce((sum, v) => Math.fround(sum + v), 0);
  const state = next(seed),
    target = Math.fround((state >>> 8) / 16777216 * total);
  let cumulative = 0, last = 0;
  for (let i = 0; i < weights.length; i++) {
    if (weights[i] > 0) {
      last = i;
      cumulative = Math.fround(cumulative + scaled[i]);
      if (target < cumulative) return [i, state];
    }
  }
  return [last, state];
}
Deno.test("weighted choices match host reference with exact U32 random state", () => {
  for (
    const weights of [[0, 1, 2, 7], [1, 1, 1], [0, 0, 3, 0], [
      1e-30,
      1e30,
      2e30,
    ], [2e38, 3e38, 0]]
  ) {
    for (const seed of [0, 1, 123, 0x80000001, 0xffffffff]) {
      assertEquals(choose(weights, seed), reference(weights, seed));
    }
  }
});
Deno.test("zero weights are ignored; invalid distributions return Nothing", () => {
  for (
    const weights of [[], [0], [0, 0, 0], [-1, 2], [1, NaN], [1, Infinity], [
      1,
      -Infinity,
    ]]
  ) assertEquals(choose(weights, 123), []);
  for (const seed of [0, 1, 123, 0xffffffff]) {
    assertEquals(choose([0, 0, 5, 0], seed), [2, next(seed)]);
  }
});
Deno.test("seed replay and proportional weights preserve choice sequences", () => {
  let seed = 0x80000001;
  for (let i = 0; i < 1000; i++) {
    const r = choose([0, 1, 2, 7], seed);
    assertEquals(choose([0, 10, 20, 70], seed), r);
    assertEquals(choose([0, 1, 2, 7], seed), r);
    seed = r[1];
  }
});
Deno.test("weighted spawn distribution follows authored proportions", () => {
  const counts = Array.from(
    fixture.guest.call("distribution", 0xf1234567) as Uint32Array,
  );
  assertEquals(counts.slice(0, 4).reduce((a, b) => a + b, 0), 10000);
  assertEquals(counts[0], 0);
  for (const [index, expected] of [[1, 1000], [2, 2000], [3, 7000]]) {
    assert(
      Math.abs(counts[index] - expected) < 150,
      `weight${index}: ${counts[index]}`,
    );
  }
  let seed = 0xf1234567;
  for (let i = 0; i < 10000; i++) seed = next(seed);
  assertEquals(counts[4], seed);
});
Deno.test.afterAll(async () => await fixture.dispose());
