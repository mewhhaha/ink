import { builtinTextures } from "@ink/schema";
import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { assetKind, catalogFromPaths, scanAssets } from "./catalog.ts";
import {
  checkName,
  makeId,
  PathError,
  resolveInside,
  stableJson,
} from "./paths.ts";

Deno.test("catalog is sorted, stable and starts with builtin meshes", () => {
  const a = catalogFromPaths([
    "b/z.glb",
    "a.obj",
    "t/b.PNG",
    "t/a.jpg",
    "s.wav",
    "readme.txt",
    "a.obj",
  ]);
  const b = catalogFromPaths([
    "t/a.jpg",
    "s.wav",
    "a.obj",
    "t/b.PNG",
    "b/z.glb",
  ]);
  assertEquals(a, b);
  assertEquals(a.assets.mesh.slice(-2), ["a.obj", "b/z.glb"]);
  assert(a.assets.mesh[0].startsWith("builtin:"));
  assertEquals(a.assets.texture, [...builtinTextures, "t/a.jpg", "t/b.PNG"]);
  assertEquals(a.assets.sound, ["s.wav"]);
  assertEquals(assetKind("x.txt"), null);
});

Deno.test("scanAssets walks directories, skips dotfiles, tolerates a missing dir", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "m/.hidden"), { recursive: true });
    await Deno.writeTextFile(join(dir, "m/a.glb"), "");
    await Deno.writeTextFile(join(dir, "m/.hidden/b.glb"), "");
    await Deno.writeTextFile(join(dir, "c.png"), "");
    const catalog = await scanAssets(dir);
    assert(catalog.assets.mesh.includes("m/a.glb"));
    assert(!catalog.assets.mesh.includes("m/.hidden/b.glb"));
    assertEquals(catalog.assets.texture, [...builtinTextures, "c.png"]);
    assertEquals((await scanAssets(join(dir, "nope"))).assets.texture, [
      ...builtinTextures,
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ids are sortable and well formed", () => {
  const id = makeId(new Date("2026-10-08T12:03:11Z"), () => 0);
  assertEquals(id, "2026-10-08T12-03-11-aaa");
  assert(makeId(new Date("2026-10-08T12:03:12Z")) > id);
  checkName(makeId());
});

Deno.test("path safety rejects traversal everywhere", () => {
  const root = "/p/assets";
  assertEquals(resolveInside(root, "a/b.png"), "/p/assets/a/b.png");
  assertEquals(resolveInside(root, "a%20b.png"), "/p/assets/a b.png");
  for (
    const bad of [
      "..",
      "../x",
      "a/../../x",
      "a/..",
      "%2e%2e/x",
      "..%2fx",
      "/etc/passwd",
      "a//b",
      "a/./b",
      "a\\..\\b",
      "",
      "a%00b",
      "%",
      "a/",
    ]
  ) {
    assertThrows(() => resolveInside(root, bad), PathError, undefined, bad);
  }
  for (
    const bad of ["", "..", "a/b", "../x", ".hidden", "a..b", "x y", "a\\b"]
  ) {
    assertThrows(() => checkName(bad), PathError, undefined, bad);
  }
  assertEquals(checkName("main"), "main");
});

Deno.test("stableJson is deterministic and compact for vectors", () => {
  const text = stableJson({ a: [1, 2, 3], b: { c: "x" }, d: [], e: undefined });
  assertEquals(
    text,
    '{\n  "a": [1, 2, 3],\n  "b": {\n    "c": "x"\n  },\n  "d": []\n}\n',
  );
  assertEquals(JSON.parse(text), { a: [1, 2, 3], b: { c: "x" }, d: [] });
  assertEquals(stableJson(JSON.parse(text)), text);
});
