import { assertEquals, assertRejects } from "@std/assert";
import { build_asset_manifest, serialize_asset_manifest } from "./build.ts";

Deno.test("asset builds are deterministic and content address every artifact", async () => {
  const ground = {
    id: "terrain/ground.bin",
    kind: "binary",
    bytes: new Uint8Array([1]),
  };
  const scene = {
    id: "scene/main.gltf",
    kind: "gltf",
    bytes: new Uint8Array([2]),
    dependencies: [ground.id],
  };
  const first = await build_asset_manifest(
    [scene, ground],
    "assets.manifest.json",
  );
  const second = await build_asset_manifest(
    [ground, scene],
    "assets.manifest.json",
  );

  assertEquals(
    serialize_asset_manifest(first.manifest),
    serialize_asset_manifest(second.manifest),
  );
  assertEquals(first.manifest.dependency_order.map(String), [
    ground.id,
    scene.id,
  ]);
  assertEquals(
    first.artifacts.every((artifact) =>
      artifact.location.startsWith("assets/.ink/")
    ),
    true,
  );
});

Deno.test("asset builds reject duplicate authored identities before publication", async () => {
  await assertRejects(
    () =>
      build_asset_manifest([
        { id: "same", kind: "binary", bytes: new Uint8Array([1]) },
        { id: "same", kind: "binary", bytes: new Uint8Array([2]) },
      ], "assets.manifest.json"),
    Error,
    'asset "same" appears more than once',
  );
});

Deno.test("asset builds snapshot authored inputs before hashing", async () => {
  const authored = {
    id: "mesh",
    kind: "binary",
    bytes: new Uint8Array([1, 2, 3]),
    dependencies: [] as string[],
  };
  const pending = build_asset_manifest([authored], "assets.manifest.json");
  authored.kind = "changed";
  authored.bytes.fill(9);
  authored.dependencies.push("missing");

  const build = await pending;
  assertEquals(build.manifest.assets[0].kind, "binary");
  assertEquals(build.manifest.assets[0].dependencies, []);
  assertEquals(build.artifacts[0].bytes, new Uint8Array([1, 2, 3]));
});

Deno.test("asset builds use locale-independent identity ordering", async () => {
  const build = await build_asset_manifest([
    { id: "ä", kind: "binary", bytes: new Uint8Array([1]) },
    { id: "z", kind: "binary", bytes: new Uint8Array([2]) },
  ], "assets.manifest.json");

  assertEquals(build.manifest.assets.map(({ id }) => id), ["z", "ä"]);
});
