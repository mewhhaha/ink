import { assertEquals, assertMatch } from "@std/assert";
import { createCompiler } from "@mewhhaha/blot";
import { libraryUrl } from "../mod.ts";
import { blotRoot } from "../tools/setup.ts";
import { compile } from "./support.ts";

const entry = new URL("./ecs.blot", import.meta.url);
const fixture = await compile(entry);
const source = await Deno.readTextFile(entry);
for (const match of source.matchAll(/entry const (test_\w+)/g)) {
  Deno.test(match[1].replaceAll("_", " "), () => {
    const result = fixture.guest.call(match[1], null) as Float32Array;
    assertEquals(result[1], 0, JSON.stringify(Array.from(result)));
  });
}

Deno.test("dense, sparse and churn paths retain exact numerical witnesses", () => {
  const { guest } = fixture;
  assertEquals(Array.from(guest.call("dense", 64) as Uint32Array), [
    64,
    64,
    2208,
    2016,
  ]);
  assertEquals(Array.from(guest.call("sparse", 64) as Uint32Array), [
    64,
    64,
    2028,
    2016,
  ]);
  assertEquals(Array.from(guest.call("churn", 64) as Uint32Array), [
    64,
    48,
    1632,
    1536,
  ]);
});

for await (
  const file of Deno.readDir(new URL("./rejected/", import.meta.url))
) {
  if (
    !file.name.startsWith("ecs_") && !file.name.startsWith("app_") &&
    !file.name.startsWith("handles_") && !file.name.startsWith("derived_")
  ) continue;
  const rejected = new URL(`./rejected/${file.name}`, import.meta.url);
  Deno.test(`${file.name} rejects its invalid typed registration`, async () => {
    const text = await Deno.readTextFile(rejected);
    const expected = text.match(/rejects: (.+)/)?.[1];
    assertEquals(typeof expected, "string");
    const compiler = await createCompiler({
      entry: rejected,
      imports: { "ink/": libraryUrl },
      executable: new URL("zig-native/zig-out/bin/blotc", blotRoot),
      stdRoot: new URL("std/", blotRoot),
      prelude: new URL("std/prelude.blot", blotRoot),
    });
    try {
      const result = await compiler.build();
      if (result.success) throw new Error("Invalid typed builder compiled");
      assertMatch(JSON.stringify(result.diagnostics), new RegExp(expected!));
    } finally {
      await compiler.dispose();
    }
  });
}
Deno.test.afterAll(() => fixture.dispose());
