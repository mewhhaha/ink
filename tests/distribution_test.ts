import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { modules } from "../mod.ts";
import { blotRoot } from "../tools/setup.ts";
import { browser } from "./browser-support.ts";

Deno.test("packed HTTP, Node and Chromium consumers run all examples", async () => {
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
    const metadata = JSON.parse(
      await Deno.readTextFile(new URL("package.json", packageRoot)),
    );
    const original = JSON.parse(
      await Deno.readTextFile(new URL("deno.json", project)),
    );
    assertEquals(
      Object.keys(metadata.exports).sort(),
      Object.keys(original.exports).sort(),
    );
    assertEquals(
      published.filter((path) => /^(?:tools|tests|\.cache)\//.test(path)),
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
import { normalMatrix, identity, createPasses } from "@ink/blot/gpu";
import { dialog } from "@ink/blot/ui";
import { input } from "@ink/blot/input";
import { cueText } from "@ink/blot/accessibility";
import { play } from "@ink/blot/audio";
if ([createPasses, dialog, input, play].some(fn => typeof fn !== "function")) throw new Error("Missing optional entry");
if (normalMatrix(identity)[0] !== 1 || cueText({ text: "Ready" }) !== "Ready") throw new Error("Adapter values failed");
const entries = await Promise.all(${
      JSON.stringify(
        Object.keys(metadata.exports).map((entry) => {
          if (entry === ".") return metadata.name;
          return metadata.name + entry.slice(1);
        }),
      )
    }.map((entry) => import(entry)));
if (entries.some(entry => Object.keys(entry).length === 0)) throw new Error("Empty exported entry");
const destination = await installLibrary(new URL("../node sources/", import.meta.url));
if ((await readdir(destination)).length !== modules.length) throw new Error("Missing Node sources");
for (const file of ${
      JSON.stringify(published.filter((path) => path.startsWith("shaders/")))
    }) {
  if (!(await readFile(new URL(file, import.meta.url), "utf8")).includes("@")) throw new Error("Missing shader " + file);
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
    const config = JSON.parse(
      await Deno.readTextFile(new URL("deno.json", project)),
    );
    const origin = `http://127.0.0.1:${server.addr.port}`;
    // No repository config, test support module, package link or sibling checkout.
    const consumer = `import { installLibrary, modules } from ${
      JSON.stringify(`${origin}/${metadata.exports["."].import.slice(2)}`)
    };
import { normalMatrix, identity, createPasses } from ${
      JSON.stringify(`${origin}/${metadata.exports["./gpu"].import.slice(2)}`)
    };
import { dialog } from ${
      JSON.stringify(`${origin}/${metadata.exports["./ui"].import.slice(2)}`)
    };
import { input } from ${
      JSON.stringify(`${origin}/${metadata.exports["./input"].import.slice(2)}`)
    };
import { cueText } from ${
      JSON.stringify(
        `${origin}/${metadata.exports["./accessibility"].import.slice(2)}`,
      )
    };
import { play } from ${
      JSON.stringify(`${origin}/${metadata.exports["./audio"].import.slice(2)}`)
    };
import { createCompiler, instantiateGuest } from ${
      JSON.stringify(config.imports["@mewhhaha/blot"])
    };
const entries = await Promise.all(${
      JSON.stringify(
        Object.values(metadata.exports).map((entry) =>
          origin + (entry as { import: string }).import.slice(1)
        ),
      )
    }.map((entry) => import(entry)));
if (entries.some(entry => Object.keys(entry).length === 0)) throw new Error("Empty exported entry");
const root = new URL("./", import.meta.url);
const installed = await installLibrary(new URL("./sources with spaces/", root));
const results = { modules: modules.length };
if ([createPasses, dialog, input, play].some(fn => typeof fn !== "function")) throw new Error("Missing adapter export");
if (normalMatrix(identity)[0] !== 1 || cueText({ text: "Ready", direction: "left" }) !== "(left) Ready") throw new Error("Adapter values failed");
for (const name of ${
      JSON.stringify(
        published.filter((path) => path.startsWith("shaders/")).map((path) =>
          path.slice(8, -5)
        ),
      )
    }) {
  const response = await fetch(${
      JSON.stringify(origin)
    } + "/shaders/" + name + ".wgsl");
  if (!response.ok || !(await response.text()).includes("@")) throw new Error("Shader missing: " + name);
}
for (const [file, name, argument] of [["orbit", "orbit", Math.PI / 2], ["ground", "height", 0], ["physics", "fall", 10], ["steps", "advance", 0.05], ["game", "sample", 0.5], ["navigation", "route", 0], ["joints", "pendulum", 16]]) {
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
    assertEquals(output.game[1], 20);
    assertEquals(output.navigation[0], 7);
    assertAlmostEquals(output.joints[2], 1, 0.002);
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
    // Resolve public names from the archive itself, never the repository config.
    const imports = Object.fromEntries(
      Object.entries(metadata.exports).map(([entry, value]) => {
        let name = metadata.name;
        if (entry !== ".") name += entry.slice(1);
        return [
          name,
          new URL((value as { import: string }).import, packageRoot).href,
        ];
      }),
    );
    const importMap = new URL(`file://${directory}/imports.json`);
    await Deno.writeTextFile(importMap, JSON.stringify({ imports }));
    const options = { root: packageRoot, importMap };
    await Deno.mkdir(new URL(".cache/", project), { recursive: true });
    const controls = await browser(
      "/examples/browser-ui.html",
      420,
      700,
      options,
    );
    try {
      await controls.waitFor("globalThis.inkReady === true");
      await controls.evaluate("document.getElementById('pause').focus()");
      await controls.key("Enter", "Enter", 13);
      assertEquals(
        await controls.evaluate("document.getElementById('pause-dialog').open"),
        true,
      );
      assertEquals(
        await controls.evaluate("document.activeElement.id"),
        "resume",
      );
      await controls.key("Escape", "Escape", 27);
      await controls.waitFor("document.activeElement.id === 'pause'");
      await controls.screenshot(
        new URL(".cache/distribution-controls.png", project).pathname,
      );
    } finally {
      await controls.dispose();
    }
    const graphics = await browser(
      "/examples/graphics.html",
      420,
      700,
      options,
    );
    try {
      await graphics.waitFor("globalThis.inkGraphics?.ready === true", 20000);
      const rendered = await graphics.evaluate<
        { frames: number; errors: unknown[]; width: number; height: number }
      >("globalThis.inkGraphics");
      assert(rendered.frames > 0 && rendered.width > 0 && rendered.height > 0);
      assertEquals(rendered.errors, []);
      assertEquals(
        await graphics.evaluate("document.getElementById('error').textContent"),
        "",
      );
      await graphics.screenshot(
        new URL(".cache/distribution-graphics.png", project).pathname,
      );
    } finally {
      await graphics.dispose();
    }
  } finally {
    await server?.shutdown();
    await Deno.remove(directory, { recursive: true });
  }
});
