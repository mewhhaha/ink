import { createCompiler } from "@mewhhaha/blot";
import { libraryUrl } from "../../mod.ts";
import { blotRoot } from "../../tools/setup.ts";
const output = new URL("../../.cache/history-benchmark/", import.meta.url);
await Deno.mkdir(output, { recursive: true });
const compiler = await createCompiler({
  entry: new URL("../../tests/perf/mechanisms.blot", import.meta.url),
  imports: {
    "ink/": libraryUrl,
    "pen/": new URL("../../tests/fixtures/pen/", import.meta.url),
  },
  executable: new URL("zig-native/zig-out/bin/blotc", blotRoot),
  stdRoot: new URL("std/", blotRoot),
  prelude: new URL("std/prelude.blot", blotRoot),
});
try {
  const build = await compiler.build();
  if (!build.success) throw Error(JSON.stringify(build.diagnostics));
  const hash = async (data: Uint8Array) =>
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new Uint8Array(data)),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
  await Deno.writeFile(new URL("mechanisms.wasm", output), build.bytes);
  await Deno.writeTextFile(
    new URL("native-workload.json", output),
    JSON.stringify(
      {
        wasm: await hash(build.bytes),
        compiler: await hash(
          await Deno.readFile(
            new URL("zig-native/zig-out/bin/blotc", blotRoot),
          ),
        ),
        rows: [64, 256, 1024].map((size) => ({
          size,
          names: ["history_original", "history_buffer"],
        })),
      },
      null,
      2,
    ),
  );
} finally {
  await compiler.dispose();
}
