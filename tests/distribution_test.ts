import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { modules } from "../mod.ts";
import { blotRoot } from "../tools/setup.ts";

const shaders = [
  "shaders/debug.wgsl",
  "shaders/display.wgsl",
  "shaders/mesh.wgsl",
  "shaders/shadow.wgsl",
  "shaders/sprite.wgsl",
];

async function sourceFiles(directory: string): Promise<number> {
  let count = 0;
  for await (const file of Deno.readDir(directory)) {
    if (file.isDirectory) {
      count += await sourceFiles(`${directory}/${file.name}`);
    } else if (file.isFile && file.name.endsWith(".blot")) count++;
  }
  return count;
}

Deno.test("packed Blot sources compile and standalone shaders load over HTTP", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ink consumer " });
  let server: Deno.HttpServer<Deno.NetAddr> | undefined;
  try {
    const project = new URL("../", import.meta.url);
    const archive = `${directory}/ink.tgz`;
    const packed = await new Deno.Command(Deno.execPath(), {
      args: ["pack", "--allow-dirty", "-o", archive],
      cwd: project,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(packed.success, new TextDecoder().decode(packed.stderr));
    const unpacked = await new Deno.Command("tar", {
      args: ["-xzf", archive, "-C", directory],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(unpacked.success, new TextDecoder().decode(unpacked.stderr));
    const listed = await new Deno.Command("tar", {
      args: ["-tf", archive],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(listed.success, new TextDecoder().decode(listed.stderr));
    const published = new TextDecoder().decode(listed.stdout).trim().split("\n")
      .map((path) => path.replace(/^package\//, ""));
    const packageRoot = new URL(`file://${directory}/package/`);
    assertEquals(
      published.filter((path) => path.startsWith("shaders/")).sort(),
      shaders,
    );
    for (const path of shaders) {
      assertEquals(
        await Deno.readFile(new URL(path, packageRoot)),
        await Deno.readFile(new URL(path, project)),
        `Changed packed shader ${path}`,
      );
    }
    const metadata = JSON.parse(
      await Deno.readTextFile(new URL("package.json", packageRoot)),
    );
    const original = JSON.parse(
      await Deno.readTextFile(new URL("deno.json", project)),
    );
    assertEquals(Object.keys(original.exports), ["."]);
    assertEquals(Object.keys(metadata.exports), ["."]);
    assertEquals(
      published.filter((path) =>
        /^(?:adapters|tools|tests|\.cache)\//.test(path)
      ),
      [],
    );
    assertEquals(
      published.filter((path) =>
        path.startsWith("examples/") && !path.endsWith(".blot")
      ),
      [],
    );
    assertEquals(
      published.filter((path) => path.startsWith("lib/")).map((path) =>
        path.slice(4, -5)
      ).sort(),
      [...modules],
    );
    for (
      const entry of Object.values(metadata.exports) as { import: string }[]
    ) {
      assert(
        published.includes(entry.import.slice(2)),
        `Missing entry ${entry.import}`,
      );
      assert(
        published.includes(entry.import.slice(2).replace(/\.js$/, ".d.ts")),
        `Missing declaration ${entry.import}`,
      );
    }
    const files = new Map<string, Uint8Array<ArrayBuffer>>();
    for (const path of published) {
      files.set(`/${path}`, await Deno.readFile(new URL(path, packageRoot)));
    }
    server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      (request) => {
        const path = new URL(request.url).pathname;
        const body = files.get(path);
        if (!body) return new Response("missing", { status: 404 });
        let type = "text/plain";
        if (path.endsWith(".js")) type = "text/javascript";
        return new Response(body, { headers: { "content-type": type } });
      },
    );
    const nodeConsumer = `import { readdir, readFile } from "node:fs/promises";
import { installLibrary, modules } from "@ink/blot";
const destination = await installLibrary(new URL("../node sources/", import.meta.url));
if ((await readdir(destination, { recursive: true, withFileTypes: true })).filter(file => file.isFile()).length !== modules.length) throw new Error("Missing Node sources");
for (const name of modules) {
  const packaged = await readFile(new URL("lib/" + name + ".blot", import.meta.url), "utf8");
  const installed = await readFile(new URL(name + ".blot", destination), "utf8");
  if (installed !== packaged) throw new Error("Changed Node source " + name);
}
console.log(modules.length);`;
    await Deno.writeTextFile(
      new URL("consumer.mjs", packageRoot),
      nodeConsumer,
    );
    let node: Deno.CommandOutput | undefined;
    try {
      node = await new Deno.Command("node", {
        args: ["consumer.mjs"],
        cwd: packageRoot,
        stdout: "piped",
        stderr: "piped",
      }).output();
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      console.log("Node unavailable; checking the HTTP consumer.");
    }
    if (node) {
      assert(node.success, new TextDecoder().decode(node.stderr));
      assertEquals(
        Number(new TextDecoder().decode(node.stdout).trim()),
        modules.length,
      );
    }
    const config = original;
    const origin = `http://127.0.0.1:${server.addr.port}`;
    for (const path of shaders) {
      const response = await fetch(`${origin}/${path}`);
      assert(response.ok, `Cannot fetch packed shader ${path}`);
      assertEquals(
        new Uint8Array(await response.arrayBuffer()),
        await Deno.readFile(new URL(path, project)),
        `Changed HTTP shader ${path}`,
      );
    }
    let nodeLocation = "";
    if (node) {
      nodeLocation = 'locations.push(new URL("./node sources/", root));';
    }
    // No repository config, test support module, package link or sibling checkout.
    const consumer = `import { installLibrary, modules } from ${
      JSON.stringify(`${origin}/${metadata.exports["."].import.slice(2)}`)
    };
import { createCompiler, instantiateGuest } from ${
      JSON.stringify(config.imports["@mewhhaha/blot"])
    };
const root = new URL("./", import.meta.url);
const installed = await installLibrary(new URL("./sources with spaces/", root));
const locations = [installed];
${nodeLocation}
const results = { modules: modules.length };
for (const location of locations) {
for (const [file, name, argument] of [["orbit", "orbit", Math.PI / 2], ["ground", "height", 0], ["physics", "fall", 10], ["steps", "advance", 0.05], ["game", "sample", 0.5], ["navigation", "route", 0], ["joints", "pendulum", 16], ["ecs", "move", 0.5]]) {
  const source = await fetch(${
      JSON.stringify(origin)
    } + "/examples/" + file + ".blot");
  if (!source.ok) throw new Error("Cannot download example " + file);
  await Deno.writeTextFile(new URL(file + ".blot", root), (await source.text()).replaceAll('"ink/', '"kit/'));
  const compiler = await createCompiler({
    entry: new URL(file + ".blot", root),
    imports: { "kit/": location },
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
      if (results[file] !== undefined && JSON.stringify(results[file]) !== JSON.stringify(value)) throw new Error("Node/HTTP witness differs: " + file);
      results[file] = value;
    } finally { guest.dispose(); }
  } finally { await compiler.dispose(); }
}
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
    assertEquals(output.game[1], 20);
    assertEquals(output.ecs, [2, 4, 6]);
    assertEquals(output.navigation[0], 7);
    assertAlmostEquals(output.joints[2], 1, 0.002);
    assertAlmostEquals(
      output.steps[5] / 60 + output.steps[3] + output.steps[4],
      0.05,
      1e-6,
    );

    assertEquals(
      await sourceFiles(`${directory}/sources with spaces`),
      modules.length,
    );
  } finally {
    await server?.shutdown();
    await Deno.remove(directory, { recursive: true });
  }
});
