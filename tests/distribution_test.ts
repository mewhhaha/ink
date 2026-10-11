import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { libraryUrl, modules } from "../mod.ts";
import { blotRoot } from "../tools/setup.ts";

Deno.test("an isolated HTTP consumer installs the package and runs the examples", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ink consumer " });
  const packageRoot = new URL("../", import.meta.url);
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  const published = [
    "mod.ts",
    "deno.json",
    "README.md",
    "LICENSE",
    "docs/architecture.md",
    "docs/blot.md",
  ];
  const actual = [];
  for await (const entry of Deno.readDir(libraryUrl)) {
    if (entry.isFile && entry.name.endsWith(".blot")) {
      actual.push(entry.name.slice(0, -5));
    }
  }
  assertEquals(
    [...modules],
    actual.sort(),
    "manifest includes every source module",
  );
  for (const name of modules) published.push(`lib/${name}.blot`);
  for (const name of ["orbit", "ground", "physics", "steps"]) {
    published.push(`examples/${name}.blot`);
  }
  for (const path of published) {
    files.set(`/${path}`, await Deno.readFile(new URL(path, packageRoot)));
  }
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      const path = new URL(request.url).pathname;
      const body = files.get(path);
      if (!body) return new Response("missing", { status: 404 });
      let type = "text/plain";
      if (path.endsWith(".ts")) type = "application/typescript";
      return new Response(body, { headers: { "content-type": type } });
    },
  );
  try {
    const config = JSON.parse(
      await Deno.readTextFile(new URL("deno.json", packageRoot)),
    );
    const origin = `http://127.0.0.1:${server.addr.port}`;
    // No repository config, test support module, package link or sibling checkout.
    const consumer = `import { installLibrary, modules } from ${
      JSON.stringify(`${origin}/mod.ts`)
    };
import { createCompiler, instantiateGuest } from ${
      JSON.stringify(config.imports["@mewhhaha/blot"])
    };
const root = new URL("./", import.meta.url);
const installed = await installLibrary(new URL("./sources with spaces/", root));
const results = { modules: modules.length };
for (const [file, name, argument] of [["orbit", "orbit", Math.PI / 2], ["ground", "height", 0], ["physics", "fall", 10], ["steps", "advance", 0.05]]) {
  const source = await fetch(${
      JSON.stringify(origin)
    } + "/examples/" + file + ".blot");
  if (!source.ok) throw new Error("Cannot download example " + file);
  await Deno.writeTextFile(new URL(file + ".blot", root), (await source.text()).replaceAll('"ink/', '"kit/'));
  const compiler = await createCompiler({
    entry: new URL(file + ".blot", root),
    imports: { "kit/": installed },
    executable: new URL(${
      JSON.stringify(new URL("zig-native/zig-out/bin/blotc", blotRoot).href)
    }),
    stdRoot: new URL(${JSON.stringify(new URL("std/", blotRoot).href)}),
    prelude: new URL(${
      JSON.stringify(new URL("std/prelude.blot", blotRoot).href)
    }),
  });
  try {
    const built = await compiler.build();
    if (!built.success) throw new Error(JSON.stringify(built.diagnostics));
    const guest = await instantiateGuest(built.bytes);
    try {
      let value = guest.call(name, argument);
      if (ArrayBuffer.isView(value)) value = Array.from(value);
      results[file] = value;
    } finally { guest.dispose(); }
  } finally { await compiler.dispose(); }
}
console.log(JSON.stringify(results));
`;
    await Deno.writeTextFile(`${directory}/consumer.ts`, consumer);
    const result = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--no-config", "--no-lock", "--quiet", "-A", "consumer.ts"],
      cwd: directory,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(result.success, new TextDecoder().decode(result.stderr));
    const output = JSON.parse(new TextDecoder().decode(result.stdout));
    assertEquals(output.modules, modules.length);
    assertAlmostEquals(output.orbit[0], -1, 1e-6);
    assertAlmostEquals(output.orbit[2], 0, 1e-6);
    assertEquals(output.ground, 1.5);
    assert(output.physics[0] < 10 && output.physics[0] > 9.9);
    assert(output.steps[0] < 10);
    assert(output.steps[1] >= output.steps[0] && output.steps[1] <= 10);
    assertEquals(output.steps[4], 0);
    assertEquals(output.steps[5], 3);
    assertAlmostEquals(
      output.steps[5] / 60 + output.steps[3] + output.steps[4],
      0.05,
      1e-6,
    );
    assertEquals(
      (await Array.fromAsync(Deno.readDir(`${directory}/sources with spaces`)))
        .length,
      modules.length,
    );
  } finally {
    await server.shutdown();
    await Deno.remove(directory, { recursive: true });
  }
});
