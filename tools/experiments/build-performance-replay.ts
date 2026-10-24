/** Build the frozen-save native replay used by the six performance experiments.
 * deno run -A tools/experiments/build-performance-replay.ts GAME SAVE OUTPUT
 * Add `immediate` and an Ink lib directory to build a baseline checkout.
 * INK_BLOT_ROOT selects the compiler installation, as in the regular benchmarks.
 */
import { createCompiler } from "@mewhhaha/blot";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { libraryUrl } from "../../mod.ts";
import { blotRoot } from "../setup.ts";

const [gamePath, savePath, outputPath, mode = "retained", inkPath] = Deno.args;
if (
  !gamePath || !savePath || !outputPath ||
  !["retained", "immediate"].includes(mode)
) {
  throw new Error("Expected GAME SAVE OUTPUT [retained|immediate] [INK_LIB]");
}
const directory = (path: string) => pathToFileURL(`${resolve(path)}/`);
const game = directory(gamePath);
const output = directory(outputPath);
await Deno.mkdir(output, { recursive: true });
const saved = await Deno.readFile(savePath);
const header = new TextDecoder().decode(saved.subarray(0, 8));
const view = new DataView(saved.buffer, saved.byteOffset, saved.byteLength);
if (
  saved.length < 20 || header !== "GDEVSAVE" || view.getUint32(8, true) !== 1
) {
  throw new Error("Expected the version 1 GDEVSAVE fixture");
}
const count = view.getUint32(16, true);
if (saved.length !== 20 + count * 4) throw new Error("Truncated save fixture");
const values = Array.from({ length: count }, (_, i) => {
  const value = view.getFloat32(20 + i * 4, true);
  if (!Number.isFinite(value)) throw new Error("Nonfinite save lane");
  if (Object.is(value, -0)) return "-0.0";
  return Number.isInteger(value) ? `${value}.0` : String(value);
});
await Deno.writeTextFile(
  new URL("native_fixture.blot", output),
  `const state: Array F32 = #[${values.join(", ")}]\n`,
);
let source = await Deno.readTextFile(
  new URL("./gdev-performance-replay.blot", import.meta.url),
);
if (mode === "immediate") {
  source = source.replace('"ink/pen/retained"', '"ink/pen/host"');
}
const entry = new URL("main.blot", output);
await Deno.writeTextFile(entry, source);
const compiler = await createCompiler({
  entry,
  executable: new URL("zig-native/zig-out/bin/blotc", blotRoot),
  stdRoot: new URL("std/", blotRoot),
  prelude: new URL("std/prelude.blot", blotRoot),
  inferenceBudget: 20_000_000,
  imports: {
    "ink/": inkPath ? directory(inkPath) : libraryUrl,
    "game/": new URL("src/", game),
    "pen/": new URL("pen/", game),
    "test/": new URL("tests/", game),
  },
  nativeAssets: {
    roots: [new URL("src/", game), new URL("devtools/", game)],
    imports: [{
      module: new URL("src/system_names.json.blot", game),
      path: new URL("src/system_names.json", game),
      kind: "text",
    }],
  },
});
try {
  const built = await compiler.build();
  if (!built.success) throw new Error(JSON.stringify(built.diagnostics));
  await Deno.writeFile(new URL("game.wasm", output), built.bytes);
  console.log(`Built ${built.bytes.length} bytes from ${count} saved lanes`);
} finally {
  await compiler.dispose();
}
