/** Paired research probes; compiler source overlays leave lib/ unchanged.
 * Run: DENO_DIR=/tmp/ink-triage-deno deno run -A tools/experiments/performance-probes.ts [probe ...]
 */
import { createCompiler, instantiateGuest } from "@mewhhaha/blot";
import { libraryUrl } from "../../mod.ts";
import { blotRoot } from "../../tools/setup.ts";
import { summary } from "../../tools/report.ts";
import { toolchain } from "../../tools/toolchain.ts";

const root = new URL("../../", import.meta.url);
const output = new URL(".cache/next-wins/", root);
await Deno.mkdir(output, { recursive: true });
const path = (file: string) => new URL(file, root).pathname;
const read = (file: string) => Deno.readTextFile(path(file));
function replace(source: string, before: string, after: string) {
  if (!source.includes(before)) throw new Error(`Missing source: ${before}`);
  return source.replace(before, after);
}
const handles = await read("lib/handles.blot");
const encode =
  `const encode = fn encode_value => fn (store: Store [kind, value]) => do:
  let payloads = array.map encode_value store.values
  let length = 7 + store.slots.length * 4 + store.owners.length + store.free.length + payloads.length
  for words in payloads:
    length := self + words.length
  let out = array.fill length 0
  out[0] := 1
  out[1] := store.region
  out[2] := store.origin
  out[3] := store.capacity
  out[4] := store.slots.length
  out[5] := store.values.length
  out[6] := store.free.length
  let cursor = 7
  for slot in store.slots:
    out[cursor] := slot.dense
    out[cursor + 1] := slot.origin
    out[cursor + 2] := slot.generation
    out[cursor + 3] := if slot.live then 1 else 0
    cursor := self + 4
  for owner in store.owners:
    out[cursor] := owner
    cursor := self + 1
  for free in store.free:
    out[cursor] := free
    cursor := self + 1
  for words in payloads:
    out[cursor] := words.length
    cursor := self + 1
    for word in words:
      out[cursor] := word
      cursor := self + 1
  return out

`;
const handlesFast = handles.slice(0, handles.indexOf("const encode =")) +
  encode + handles.slice(handles.indexOf("const decode ="));
await Deno.writeTextFile(new URL("handles.blot", output), handlesFast);

const ecs = await read("lib/ecs.blot");
const pairStart = ecs.indexOf("const update_pair =");
const pairEnd = ecs.indexOf("const update_triple =");
let pair = ecs.slice(pairStart, pairEnd);
pair = replace(
  pair,
  "  let results = array.generate leaves",
  `  let empty_left = array.fill leaf_size #Nothing
  let empty_right = array.fill leaf_size #Nothing
  let results = array.generate leaves`,
);
pair = replace(
  pair,
  "    let start = leaf << leaf_bits",
  `    if word_mask bits leaf & (word_mask left_column.masks leaf | word_mask right_column.masks leaf) == 0:
      return (empty_left, empty_right)
    let start = leaf << leaf_bits`,
);
pair = replace(
  pair,
  "  use set (make_column (grouped",
  `  let rebuilt = fn old => fn values => do:
    let masks = array.generate leaves (fn word => word_mask bits word & word_mask old word)
    return #Column { values, masks, occupied: occupied_words masks }
  use set (rebuilt left_column.masks (grouped`,
);
pair = replace(
  pair,
  "  return set (make_column (grouped",
  "  return set (rebuilt right_column.masks (grouped",
);
const ecsFast = ecs.slice(0, pairStart) + pair + ecs.slice(pairEnd);
await Deno.writeTextFile(new URL("ecs.blot", output), ecsFast);

const render = await read("tests/render-cache.blot");
let retained = 'import * as keyed from "ink/derived/keyed"\n' + render;
retained = replace(
  retained,
  "    let cached = original",
  "    let collected = #keyed.Cold\n    let cached = original",
);
retained = replace(
  retained,
  "      let draws = if retained then cache.collect cache.all cached else",
  `      let (next_collection, cached_draws) = keyed.resolve (fn (a: U32) => fn b => a == b) (fn key => cache.collect cache.all cached) (if divisor == 0 then 0 else frame) collected
      collected := next_collection
      let draws = if retained then cached_draws else`,
);
await Deno.writeTextFile(new URL("render-cache.blot", output), retained);

const words = await read("lib/persist/words.blot");
const sparseColumn =
  `const column = fn (c: codec.Persistence a) => fn (source: ecs.ReadView a) => do:
  let indices = array.fill (source.occupied.length * 32) 0
  let count = 0
  for word in source.occupied:
    let alive = if word < source.bits.length then source.bits[word] else 0
    let present = if word < source.masks.length then source.masks[word] else 0
    let mask = alive & present
    for slot in 0 .. 32:
      if (mask >> slot) & 1 != 0 && (word << 5) + slot < source.count:
        indices[count] := (word << 5) + slot
        count := self + 1
  let payloads = array.generate count (fn at => do:
    let #Some value = ecs.read source indices[at] else:
      return @panic "sparse save membership"
    return c.encode value)
  let length = 2
  for payload in payloads:
    use require (length <= 4294967293)
    use require (payload.length <= 4294967293 - length)
    length := self + 2 + payload.length
  let words = array.fill length 0
  words[0] := source.count
  words[1] := count
  let cursor = 2
  for at in 0 .. count:
    let payload = payloads[at]
    words[cursor] := indices[at]
    words[cursor + 1] := payload.length
    for offset in 0 .. payload.length:
      words[cursor + 2 + offset] := payload[offset]
    cursor := self + 2 + payload.length
  return words
`;
const wordsFast =
  (words.slice(0, words.indexOf("const column =")) + sparseColumn +
    words.slice(words.indexOf("const read_column =")))
    .replaceAll("<- ecs.components", "<- ecs.view").replaceAll(
      "<- ecs.previous_components",
      "<- ecs.previous_view",
    );
await Deno.writeTextFile(new URL("words.blot", output), wordsFast);

const math = await read("lib/math.blot");
const transform = await read("lib/transform.blot");
const fused = `
const interpolated_matrix = fn (a: Pose3) => fn (b: Pose3) => fn (weight: F32) => do:
  let #math.Quat { x: ax, y: ay, z: az, w: aw } = math.Quat.normalized a.rotation
  let #math.Quat { x: bx, y: by, z: bz, w: bw } = math.Quat.normalized b.rotation
  let #math.Quat { x, y, z, w } = math.nlerp_parts ax ay az aw bx by bz bw weight
  return math.compose_parts (F32.lerp a.position.x b.position.x weight) (F32.lerp a.position.y b.position.y weight) (F32.lerp a.position.z b.position.z weight)
    x y z w (F32.lerp a.scale.x b.scale.x weight) (F32.lerp a.scale.y b.scale.y weight) (F32.lerp a.scale.z b.scale.z weight)
`;
const renderCache = await read("lib/render/cache.blot");
const fusedCache = renderCache.replaceAll(
  "transform.interpolate old pose alpha",
  "transform.interpolated_matrix old pose alpha",
)
  .replaceAll("#Nothing => pose", "#Nothing => transform.matrix pose")
  .replaceAll(
    "render.draw shown appearance",
    "#render.Draw { mesh: appearance.mesh, material: appearance.material, matrix: shown, parameters: #Nothing, extra: #[] }",
  );
const fusedSources = {
  [path("lib/math.blot")]: replace(
    math,
    "private const compose_parts",
    "const compose_parts",
  ),
  [path("lib/transform.blot")]: transform + fused,
  [path("lib/render/cache.blot")]: fusedCache,
};
const interpolation = await read("tools/experiments/interpolation.blot");

type Probe = {
  name: string;
  file: string;
  sources: Record<string, string>;
  entries: string[];
  sizes: number[];
  checks?: [string, number | null][];
};
const probes: Probe[] = [
  {
    name: "handles-lifecycle",
    file: "tests/handles.blot",
    sources: { [path("lib/handles.blot")]: handlesFast },
    entries: [],
    sizes: [],
    checks: [["lifecycle", null], ["saved", null], ["exhaustion", null], [
      "workload",
      0,
    ], ["workload", 1024]],
  },
  {
    name: "handles-encode",
    file: "tools/experiments/handles-save.blot",
    sources: { [path("lib/handles.blot")]: handlesFast },
    entries: ["save", "roundtrip"],
    sizes: [256, 1024, 4096, 8192],
    checks: [["save", 0], ["save", 1], ["roundtrip", 0], ["roundtrip", 1]],
  },
  {
    name: "ecs-history",
    file: "tests/ecs-history.blot",
    sources: { [path("lib/ecs.blot")]: ecsFast },
    entries: ["workload"],
    sizes: [1024, 8192, 65536],
  },
  {
    name: "ecs-control",
    file: "tests/ecs.blot",
    sources: { [path("lib/ecs.blot")]: ecsFast },
    entries: ["dense", "sparse", "churn"],
    sizes: [256, 4096],
    checks: Array.from(
      (await read("tests/ecs.blot")).matchAll(
        /^entry const (test_\w+) = fn \(\)/gm,
      ),
      (m) => [m[1], null],
    ),
  },
  {
    name: "render-collect",
    file: "tests/render-cache.blot",
    sources: { [path("tests/render-cache.blot")]: retained },
    entries: ["static_frames", "sparse_frames", "moving_frames"],
    sizes: [256, 4096],
  },
  {
    name: "sparse-save",
    file: "tools/experiments/sparse-save.blot",
    sources: { [path("lib/persist/words.blot")]: wordsFast },
    entries: ["save", "roundtrip"],
    sizes: [1024, 8192, 65536],
  },
  {
    name: "save-control",
    file: "tests/word-persist.blot",
    sources: { [path("lib/persist/words.blot")]: wordsFast },
    entries: ["save", "roundtrip"],
    sizes: [64, 1024],
    checks: [["save", 0], ["save", 1], ["roundtrip", 0], [
      "scene_restore",
      null,
    ], ["migration", null]],
  },
  {
    name: "fused-render",
    file: "tests/render-cache.blot",
    sources: fusedSources,
    entries: ["sparse_frames", "moving_frames"],
    sizes: [1024, 4096],
    checks: [["edits", null], ["explicit_changes", null]],
  },
  {
    name: "fused-numerical",
    file: "tools/experiments/interpolation.blot",
    sources: {
      ...fusedSources,
      [path("tools/experiments/interpolation.blot")]: replace(
        interpolation,
        "transform.matrix (transform.interpolate a b t)",
        "transform.interpolated_matrix a b t",
      ),
    },
    entries: ["matrices"],
    sizes: [256, 4096],
  },
];
const results = [];
const checks = [];
const hashes = async (sources: Record<string, string>) =>
  Object.fromEntries(
    await Promise.all(
      Object.entries(sources).map(async (
        [file, source],
      ) => [
        file.slice(root.pathname.length),
        Array.from(
          new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(source),
            ),
          ),
          (b) => b.toString(16).padStart(2, "0"),
        ).join(""),
      ]),
    ),
  );
const head = await new Deno.Command("git", {
  args: ["rev-parse", "HEAD"],
  cwd: root,
}).output();
if (!head.success) throw new Error("Cannot identify the library checkout");
const provenance = {
  toolchain: toolchain(),
  recordedAt: new Date().toISOString(),
  baseline: new TextDecoder().decode(head.stdout).trim(),
  baselineSources: await hashes(Object.fromEntries(
    await Promise.all([
      "lib/handles.blot",
      "lib/ecs.blot",
      "lib/persist/words.blot",
      "lib/render/cache.blot",
      "lib/math.blot",
      "lib/transform.blot",
      "tests/ecs-history.blot",
      "tests/ecs.blot",
      "tests/render-cache.blot",
      "tests/word-persist.blot",
      "tests/handles.blot",
      "tools/experiments/handles-save.blot",
      "tools/experiments/sparse-save.blot",
      "tools/experiments/interpolation.blot",
      "tools/experiments/performance-probes.ts",
    ].map(async (file) => [path(file), await read(file)])),
  )),
  method:
    "Same compiler; 20 warmup, 15 measured alternating pairs; setup included; full outputs compared outside timing. Committed memory is the guest high-water mark across successive workloads.",
};
const overlays = {} as Record<string, Record<string, string>>;
for (
  const probe of probes.filter((p) =>
    Deno.args.length === 0 || Deno.args.includes(p.name)
  )
) {
  overlays[probe.name] = await hashes(probe.sources);
  const fixtures = [];
  try {
    for (const sources of [{}, probe.sources]) {
      const compiler = await createCompiler({
        entry: new URL(probe.file, root),
        imports: { "ink/": libraryUrl },
        executable: new URL("zig-native/zig-out/bin/blotc", blotRoot),
        stdRoot: new URL("std/", blotRoot),
        prelude: new URL("std/prelude.blot", blotRoot),
      });
      const result = await compiler.build({ sources });
      if (!result.success) {
        await compiler.dispose();
        throw new Error(JSON.stringify(result.diagnostics));
      }
      fixtures.push({ compiler, guest: await instantiateGuest(result.bytes) });
    }
    for (const [entry, input] of probe.checks ?? []) {
      const values = fixtures.map((f) => f.guest.call(entry, input));
      if (JSON.stringify(values[0]) !== JSON.stringify(values[1])) {
        throw new Error(`Changed semantics: ${probe.name} ${entry}`);
      }
      checks.push({ probe: probe.name, entry, input, matched: true });
    }
    for (const entry of probe.entries) {
      for (const size of probe.sizes) {
        const samples: number[][] = [[], []], ratios = [];
        let witness: number[] = [];
        for (let round = 0; round < 35; round++) {
          const elapsed = [0, 0], values: number[][] = [[], []];
          for (let turn = 0; turn < 2; turn++) {
            const at = (turn + round) % 2, start = performance.now();
            const result = fixtures[at].guest.call(entry, size) as
              | Float32Array
              | Uint32Array;
            elapsed[at] = performance.now() - start;
            values[at] = Array.from(result);
            if (round >= 20) samples[at].push(elapsed[at]);
          }
          if (values[0].join() !== values[1].join()) {
            throw new Error(`Witness mismatch ${probe.name} ${entry} ${size}`);
          }
          witness = values[0];
          if (round >= 20) ratios.push(elapsed[1] / elapsed[0]);
        }
        const result = {
          name: probe.name,
          entry,
          size,
          before: summary(samples[0]),
          after: summary(samples[1]),
          ratio: summary(ratios),
          committedBytes: fixtures.map((f) => f.guest.memoryBytes()),
          witnessLength: witness.length,
          witness: witness.length < 32 ? witness : undefined,
        };
        results.push(result);
        console.log(JSON.stringify(result));
        await Deno.writeTextFile(
          new URL("results.json", output),
          JSON.stringify(
            { ...provenance, overlays, checks, results },
            null,
            2,
          ) + "\n",
        );
      }
    }
  } finally {
    for (const fixture of fixtures) {
      fixture.guest.dispose();
      await fixture.compiler.dispose();
    }
  }
}

await Deno.writeTextFile(
  new URL("results.json", output),
  JSON.stringify({ ...provenance, overlays, checks, results }, null, 2) + "\n",
);
