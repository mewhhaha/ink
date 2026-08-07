import { assertEquals } from "@std/assert";
import { parse_asset_manifest } from "./manifest.ts";

const empty_digest =
  "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

Deno.test("manifest parsing produces a deterministic dependency-first order", () => {
  const result = parse_asset_manifest({
    version: 1,
    assets: [
      entry("world/mesh", ["world/texture"]),
      entry("world/texture"),
      entry("audio/theme"),
    ],
  }, "assets.json");

  if (result.type !== "ready") throw new Error(result.reason);
  assertEquals(result.manifest.assets.map((asset) => asset.id), [
    "audio/theme",
    "world/mesh",
    "world/texture",
  ]);
  assertEquals(result.manifest.dependency_order.map(String), [
    "audio/theme",
    "world/texture",
    "world/mesh",
  ]);
});

Deno.test("manifest parsing reports dependency cycles with source and asset evidence", () => {
  const result = parse_asset_manifest({
    version: 1,
    assets: [entry("a", ["b"]), entry("b", ["a"])],
  }, "broken.json");

  assertEquals(result, {
    type: "invalid_manifest",
    source: "broken.json",
    field: "dependencies",
    asset_id: "a",
    reason: 'asset dependency cycle is "a" -> "b" -> "a"',
  });
});

Deno.test("manifest parsing rejects references to missing assets", () => {
  const result = parse_asset_manifest({
    version: 1,
    assets: [entry("world/mesh", ["world/missing"])],
  }, "assets.json");

  assertEquals(result, {
    type: "invalid_manifest",
    source: "assets.json",
    field: "dependencies",
    asset_id: "world/mesh",
    reason: 'asset "world/mesh" depends on missing asset "world/missing"',
  });
});

Deno.test("manifest parsing rejects variant names that collide after trimming", () => {
  const fixture = entry("texture");
  const variant = {
    artifact_revision: "artifact-2",
    byte_size: 0,
    digest: empty_digest,
    location: "texture.bin",
  };
  const result = parse_asset_manifest({
    version: 1,
    assets: [{
      ...fixture,
      variants: { mobile: variant, " mobile ": variant },
    }],
  }, "assets.json");

  assertEquals(result.type, "invalid_manifest");
  if (result.type === "invalid_manifest") {
    assertEquals(result.reason, 'asset "texture" repeats variant "mobile"');
  }
});

Deno.test("manifest parsing reports a non-string source at the boundary", () => {
  const result = parse_asset_manifest({ version: 1, assets: [] }, 42 as never);
  assertEquals(result, {
    type: "invalid_manifest",
    source: "42",
    field: "source",
    reason: "manifest source 42 must be a string",
  });
});

function entry(id: string, dependencies: readonly string[] = []) {
  return {
    id,
    kind: "fixture",
    source_revision: "source-1",
    artifact_revision: "artifact-1",
    byte_size: 0,
    digest: empty_digest,
    location: `${id}.bin`,
    dependencies,
    variants: {},
  };
}
