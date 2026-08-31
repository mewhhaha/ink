import { assertEquals } from "@std/assert";
import { build_asset_manifest } from "./build.ts";
import { replace_asset_bundle } from "./bundle.ts";
import { AssetCache } from "./cache.ts";
import { asset_id } from "./identity.ts";

Deno.test("bundle publication verifies every digest before replacing the current scene", async () => {
  const original = await build_asset_manifest([
    { id: "room/mesh", kind: "mesh", bytes: new Uint8Array([1]) },
    {
      id: "room/scene",
      kind: "scene",
      bytes: new Uint8Array([2]),
      dependencies: ["room/mesh"],
    },
  ], "original.json");
  const replacement = await build_asset_manifest([
    { id: "room/mesh", kind: "mesh", bytes: new Uint8Array([3]) },
    {
      id: "room/scene",
      kind: "scene",
      bytes: new Uint8Array([4]),
      dependencies: ["room/mesh"],
    },
  ], "replacement.json");
  const cache = new AssetCache(16);
  const first = await replace_asset_bundle({
    cache,
    manifest: original.manifest,
    reader: artifact_reader(original.artifacts),
    root: asset_id("room/scene"),
  });
  if (first.type !== "ready") {
    throw new Error(`original bundle failed: ${first.type}`);
  }
  const corrupted_reader = artifact_reader(
    replacement.artifacts.map((artifact) =>
      artifact.id === asset_id("room/mesh")
        ? { ...artifact, bytes: new Uint8Array([9]) }
        : artifact
    ),
  );
  const second = await replace_asset_bundle({
    cache,
    manifest: replacement.manifest,
    reader: corrupted_reader,
    root: asset_id("room/scene"),
  });

  assertEquals(second.type, "failed");
  assertEquals(first.lease.read(asset_id("room/mesh")), new Uint8Array([1]));
  const retained = cache.acquire(asset_id("room/scene"));
  if (retained === undefined) throw new Error("current scene was discarded");
  assertEquals(retained.read(), new Uint8Array([2]));
  retained.release();
  first.lease.release();
});

Deno.test("bundle publication leases a complete dependency closure", async () => {
  const build = await build_asset_manifest([
    { id: "room/texture", kind: "texture", bytes: new Uint8Array([1]) },
    {
      id: "room/mesh",
      kind: "mesh",
      bytes: new Uint8Array([2]),
      dependencies: ["room/texture"],
    },
    {
      id: "room/scene",
      kind: "scene",
      bytes: new Uint8Array([3]),
      dependencies: ["room/mesh"],
    },
    { id: "other", kind: "unrelated", bytes: new Uint8Array([4]) },
  ], "assets.json");
  const cache = new AssetCache(8);
  const loaded = await replace_asset_bundle({
    cache,
    manifest: build.manifest,
    reader: artifact_reader(build.artifacts),
    root: asset_id("room/scene"),
  });
  if (loaded.type !== "ready") {
    throw new Error(`bundle failed: ${loaded.type}`);
  }

  assertEquals(loaded.lease.assets, [
    asset_id("room/texture"),
    asset_id("room/mesh"),
    asset_id("room/scene"),
  ]);
  assertEquals(cache.state(asset_id("other")).type, "unavailable");
  loaded.lease.release();
});

function artifact_reader(
  artifacts: readonly {
    readonly location: string;
    readonly bytes: Uint8Array;
  }[],
) {
  const bytes_by_location = new Map(
    artifacts.map(({ location, bytes }) => [location, bytes] as const),
  );
  return {
    read(location: string): Promise<Uint8Array> {
      const bytes = bytes_by_location.get(location);
      if (bytes === undefined) {
        throw new Error(
          `fixture artifact ${JSON.stringify(location)} is missing`,
        );
      }
      return Promise.resolve(bytes);
    },
  };
}
