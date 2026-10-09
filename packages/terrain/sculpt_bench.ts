/**
 * Cost of one brush dab on a 2049x2049 heightfield (a 2 km terrain with 1 m
 * cells): radius 64 m, so 129x129 = 16.6 thousand samples per dab, the
 * pointer moving 1 m between dabs.
 *
 *   deno run -A packages/terrain/sculpt_bench.ts
 */
import { Heightfield } from "@ink/geometry";
import {
  type Dab,
  flatten,
  type Ground,
  noiseRelief,
  paintLayer,
  raise,
  smooth,
} from "./sculpt.ts";

const field = Heightfield.create(2048, { splatCells: 1024, layers: 4 });
const ground: Ground = { field, size: 2048 };
const falloff = { shape: "smooth", hardness: 0.2 } as const;
const dabs = (n: number): Dab[] =>
  Array.from({ length: n }, (_, i) => ({
    x: -300 + i * 1, // 1 m spacing along the stroke
    z: 100 + Math.sin(i / 40) * 20,
    radius: 64,
    falloff,
  }));

function time(name: string, run: (dab: Dab) => void, count = 200) {
  const list = dabs(count);
  for (const dab of list.slice(0, 10)) run(dab); // warm up
  const start = performance.now();
  for (const dab of list) run(dab);
  const each = (performance.now() - start) / count;
  console.log(`${name.padEnd(10)} ${each.toFixed(3)} ms per dab`);
  return each;
}

console.log(
  `${field.stride}x${field.stride} samples, radius 64 m, 1 m spacing`,
);
time("raise", (d) => raise(ground, d, 0.05));
time("smooth", (d) => smooth(ground, d, 0.3, 4));
time("flatten", (d) => flatten(ground, d, 3, 0.3));
time("noise", (d) =>
  noiseRelief(ground, d, {
    seed: 3,
    scale: 24,
    octaves: 3,
    metres: 0.05,
  }), 60);
time("paint", (d) => paintLayer(ground, d, 2, 0.1));
