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

Deno.test("atlas files are their own asset kind and describe their frames", async () => {
  assertEquals(assetKind("sets/tiles.atlas.json"), "atlas");
  assertEquals(assetKind("settings.json"), null);
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "sets"));
    await Deno.writeTextFile(
      join(dir, "sets/tiles.atlas.json"),
      JSON.stringify({
        image: "tiles.png",
        grid: { cell: [8, 8], columns: 2, rows: 1 },
        names: { floor: 0 },
        tiles: { floor: "solid" },
      }),
    );
    await Deno.writeTextFile(join(dir, "sets/broken.atlas.json"), "{");
    await Deno.writeTextFile(join(dir, "sets/tiles.png"), "");
    const catalog = await scanAssets(dir);
    assertEquals(catalog.assets.atlas, [
      "sets/broken.atlas.json",
      "sets/tiles.atlas.json",
    ]);
    // The broken file is listed but described by nothing, and does not fail
    // the scan.
    assertEquals(Object.keys(catalog.atlases ?? {}), ["sets/tiles.atlas.json"]);
    const info = catalog.atlases!["sets/tiles.atlas.json"];
    assertEquals(info.frames, ["floor", "cell_1"]);
    assertEquals(info.tiles, [0, 1, 0]);
    assertEquals(info.image, "sets/tiles.png");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("long runs of numbers wrap instead of taking a line each", () => {
  const cells = Array.from({ length: 300 }, (_, i) => i % 10);
  const text = stableJson({ cells });
  assert(text.split("\n").length < 20, "wrapped");
  assert(text.split("\n").every((line) => line.length <= 100));
  assertEquals(JSON.parse(text).cells, cells);
  assertEquals(stableJson(JSON.parse(text)), text);
});
