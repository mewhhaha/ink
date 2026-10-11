import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { pathToFileURL } from "node:url";
import {
  installCache,
  recoverCache,
  sealCache,
  validCache,
} from "../tools/cache.ts";
import { compilerCacheCurrent, revision } from "../tools/setup.ts";
import { affectedTests } from "../tools/test.ts";
import { measure, summary } from "../tools/report.ts";

async function temporary(run: (root: URL) => Promise<void>) {
  const path = await Deno.makeTempDir({ prefix: "ink-tooling-test-" });
  try {
    await run(pathToFileURL(`${path}/`));
  } finally {
    await Deno.remove(path, { recursive: true });
  }
}

Deno.test("compiler cache checks binary and every standard library file", async () => {
  await temporary(async (root) => {
    await Deno.mkdir(new URL("zig-native/zig-out/bin/", root), {
      recursive: true,
    });
    await Deno.mkdir(new URL("std/", root));
    const binary = new URL("zig-native/zig-out/bin/blotc", root);
    await Deno.writeTextFile(binary, "fake binary");
    await Deno.chmod(binary, 0o755);
    await Deno.writeTextFile(new URL(".setup-revision", root), revision);
    assertEquals(await compilerCacheCurrent(root), false);
    for (const name of ["prelude", "array", "vector", "list"]) {
      await Deno.writeTextFile(new URL(`std/${name}.blot`, root), name);
    }
    assertEquals(await compilerCacheCurrent(root), false);
    await sealCache(root, revision, [
      "zig-native/zig-out/bin/blotc",
      "std/prelude.blot",
      "std/array.blot",
      "std/vector.blot",
      "std/list.blot",
    ]);
    assertEquals(await compilerCacheCurrent(root), true);
    await Deno.writeTextFile(new URL("std/array.blot", root), "ARRAY");
    assertEquals(await compilerCacheCurrent(root), false);
    await Deno.writeTextFile(new URL("std/array.blot", root), "array");
    assertEquals(await compilerCacheCurrent(root), true);
    await Deno.writeTextFile(new URL("std/extra.blot", root), "unexpected std");
    assertEquals(await compilerCacheCurrent(root), false);
    await Deno.remove(new URL("std/extra.blot", root));
    await Deno.writeTextFile(binary, "fake Binary");
    assertEquals(await compilerCacheCurrent(root), false);
  });
});

Deno.test("interrupted cache swaps recover the old payload and failed installs roll back", async () => {
  await temporary(async (parent) => {
    const root = new URL("cache/", parent);
    const stage = new URL("stage/", parent);
    await Deno.mkdir(root);
    await Deno.writeTextFile(new URL("binary", root), "old");
    await sealCache(root, "one", ["binary"]);
    await Deno.rename(root, new URL("cache.previous/", parent));
    await recoverCache(root);
    assertEquals(await validCache(root, "one", ["binary"]), true);
    await assertRejects(() => installCache(stage, root), Deno.errors.NotFound);
    assertEquals(await validCache(root, "one", ["binary"]), true);
    await Deno.mkdir(stage);
    await Deno.writeTextFile(new URL("binary", stage), "new");
    await sealCache(stage, "two", ["binary"]);
    await installCache(stage, root);
    assertEquals(await validCache(root, "two", ["binary"]), true);
    await Deno.remove(new URL("binary", root));
    assertEquals(await validCache(root, "two", ["binary"]), false);
  });
});

Deno.test("malformed JSON cache manifests are rejected and replaced by a sealed payload", async () => {
  await temporary(async (parent) => {
    const root = new URL("cache/", parent);
    const stage = new URL("stage/", parent);
    await Deno.mkdir(root);
    await Deno.writeTextFile(new URL("binary", root), "old");
    const invalid = [
      null,
      [],
      {},
      { revision: "one", files: null },
      { revision: "one", files: [] },
      { revision: "one", files: { binary: null } },
      { revision: "one", files: { binary: { bytes: 3, sha256: "invalid" } } },
      {
        revision: "one",
        files: { binary: { bytes: -1, sha256: "0".repeat(64) } },
      },
      {
        revision: "one",
        files: { binary: { bytes: "3", sha256: "0".repeat(64) } },
      },
      {
        revision: "one",
        files: { "../binary": { bytes: 3, sha256: "0".repeat(64) } },
      },
    ];
    for (const manifest of invalid) {
      await Deno.writeTextFile(
        new URL(".setup-manifest.json", root),
        JSON.stringify(manifest),
      );
      assertEquals(await validCache(root, "one", ["binary"]), false);
    }
    await Deno.mkdir(stage);
    await Deno.writeTextFile(new URL("binary", stage), "new");
    await sealCache(stage, "one", ["binary"]);
    await installCache(stage, root);
    assertEquals(await validCache(root, "one", ["binary"]), true);
    assertEquals(await Deno.readTextFile(new URL("binary", root)), "new");
  });
});

Deno.test("affected selection follows dynamic fixture paths and transitive Blot imports", async () => {
  await temporary(async (root) => {
    for (const name of ["tests", "lib"]) {
      await Deno.mkdir(new URL(`${name}/`, root));
    }
    const files = ["tests/one_test.ts", "tests/two_test.ts"];
    await Deno.writeTextFile(
      new URL(files[0], root),
      'const fixture = await compile(new URL("./one.blot", import.meta.url));',
    );
    await Deno.writeTextFile(
      new URL(files[1], root),
      'const fixture = await compile(new URL("./two.blot", import.meta.url));',
    );
    await Deno.writeTextFile(
      new URL("tests/one.blot", root),
      'import * as a from "ink/outer"',
    );
    await Deno.writeTextFile(
      new URL("tests/two.blot", root),
      'import * as a from "ink/other"',
    );
    await Deno.writeTextFile(
      new URL("lib/outer.blot", root),
      'import * as a from "./inner"',
    );
    await Deno.writeTextFile(
      new URL("lib/inner.blot", root),
      'import * as a from "ink/outer"',
    );
    assertEquals(await affectedTests(["lib/inner.blot"], files, root), [
      files[0],
    ]);
    assertEquals(await affectedTests(["tests/two.blot"], files, root), [
      files[1],
    ]);
    assertEquals(await affectedTests(["deno.json"], files, root), files);
    await Deno.writeTextFile(
      new URL(files[1], root),
      `const code = "import('/tests/two.blot')";`,
    );
    assertEquals(await affectedTests(["tests/two.blot"], files, root), [
      files[1],
    ]);
  });
});

Deno.test("benchmark summaries retain spread, warmup and meaningful output", () => {
  assertEquals(summary([4, 1, 3, 2, 5]), {
    median: 3,
    min: 1,
    max: 5,
    medianAbsoluteDeviation: 1,
    samples: 5,
  });
  assertThrows(() => summary([]));
  assertThrows(() => summary([NaN]));
  assertEquals(summary([1, 2, 3, 6]), {
    median: 2.5,
    min: 1,
    max: 6,
    medianAbsoluteDeviation: 1,
    samples: 4,
  });
  let calls = 0;
  const result = measure(() => ++calls, 3, 5);
  assertEquals(calls, 8);
  assertEquals(result.warmup, 3);
  assertEquals(result.witness, 8);
  assertEquals(result.milliseconds.samples, 5);
});
