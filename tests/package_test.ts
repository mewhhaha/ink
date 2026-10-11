import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { libraryUrl, modules } from "../mod.ts";
import { compile } from "./support.ts";

const root = new URL("../", import.meta.url);
const documents = [
  "README.md",
  "docs/architecture.md",
  "docs/blot.md",
  "docs/shaders.md",
];
const imports = (source: string) =>
  Array.from(
    source.matchAll(/\b(?:from|import)\s*(?:\(\s*)?["']([^"']+)["']/g),
    (match) => match[1],
  );

Deno.test("published entries and core imports preserve the package boundary", async () => {
  const readme = await Deno.readTextFile(new URL("README.md", root));
  const config = JSON.parse(
    await Deno.readTextFile(new URL("deno.json", root)),
  );
  assertEquals(config.exports, { ".": "./mod.ts" });
  assert(readme.includes("mod.ts"));
  const entry = await Deno.readTextFile(new URL(config.exports["."], root));
  assert(
    imports(entry).every((path) => path.startsWith("node:")),
    "source installer uses only platform built-ins",
  );
  for (const name of modules) {
    assert(readme.includes(`ink/${name}`), `Undocumented module ${name}`);
    const file = new URL(`${name}.blot`, libraryUrl);
    for (const path of imports(await Deno.readTextFile(file))) {
      if (path.startsWith("std/")) continue;
      const dependency = new URL(`${path}.blot`, file);
      assert(
        path.startsWith("./") && dependency.href.startsWith(libraryUrl.href),
        `Core import outside Ink/std: ${path}`,
      );
      assert((await Deno.stat(dependency)).isFile);
    }
  }
});

Deno.test("documentation links, module names and executable TS/Blot fences remain valid", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ink-documentation-" });
  let examples = 0;
  try {
    for (const name of documents) {
      const document = new URL(name, root);
      const text = await Deno.readTextFile(document);
      for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        if (/^https?:/.test(match[1])) continue;
        const target = new URL(match[1], document);
        assert(
          (await Deno.stat(target)).isFile,
          `${name}: missing ${match[1]}`,
        );
      }
      for (const match of text.matchAll(/["'`]ink\/([a-z_]+)/g)) {
        assert(
          modules.includes(match[1]),
          `${name}: unknown module ${match[1]}`,
        );
      }
      for (const match of text.matchAll(/^```(ts|blot)\n([\s\S]*?)^```/gm)) {
        const [, language, source] = match;
        const file = new URL(`file://${directory}/${examples++}.${language}`);
        if (language === "ts") {
          // The vendored location is chosen by the caller; the displayed API is exact.
          const code = source.replaceAll(
            "./vendor/ink/mod.ts",
            new URL("mod.ts", root).href,
          );
          await Deno.writeTextFile(
            file,
            `${code}\nif (!(imports["ink/"] instanceof URL)) throw new Error("Missing library location");\n`,
          );
          const result = await new Deno.Command(Deno.execPath(), {
            args: [
              "run",
              "--check",
              "--no-config",
              "--no-lock",
              "--quiet",
              "-A",
              file.pathname,
            ],
            cwd: directory,
            stdout: "piped",
            stderr: "piped",
          }).output();
          assert(
            result.success,
            `${name}: ${new TextDecoder().decode(result.stderr)}`,
          );
        } else {
          await Deno.writeTextFile(file, source);
          const fixture = await compile(file);
          try {
            if (source.includes("entry const orbit")) {
              const result = fixture.guest.call(
                "orbit",
                Math.PI / 2,
              ) as Float32Array;
              assertAlmostEquals(result[0], -1, 1e-6);
              assertAlmostEquals(result[2], 0, 1e-6);
            } else if (source.includes("entry const height")) {
              assertEquals(fixture.guest.call("height", 0), 1.5);
            } else {
              throw new Error(`Add a numerical witness for ${name}'s example`);
            }
          } finally {
            await fixture.dispose();
          }
        }
      }
    }
    assertEquals(examples, 4);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
