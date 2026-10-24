import { createCompiler, instantiateGuest } from "@mewhhaha/blot";
import { libraryUrl } from "../mod.ts";
import { blotRoot } from "../tools/setup.ts";

for (
  const [name, argument] of [
    ["orbit", Math.PI / 2],
    ["ground", 0],
    ["physics", 10],
    ["steps", 0.05],
    ["game", 0.5],
    ["navigation", 0],
    ["joints", 16],
    ["cinematic", 4.5],
    ["mechanisms", 0],
  ] as const
) {
  const compiler = await createCompiler({
    entry: new URL(`./${name}.blot`, import.meta.url),
    imports: { "ink/": libraryUrl },
    executable: new URL("zig-native/zig-out/bin/blotc", blotRoot),
    stdRoot: new URL("std/", blotRoot),
    prelude: new URL("std/prelude.blot", blotRoot),
  });
  try {
    const result = await compiler.build();
    if (!result.success) throw new Error(JSON.stringify(result.diagnostics));
    const guest = await instantiateGuest(result.bytes);
    try {
      console.log(name, guest.call(guest.abi.functions[0].name, argument));
    } finally {
      guest.dispose();
    }
  } finally {
    await compiler.dispose();
  }
}
