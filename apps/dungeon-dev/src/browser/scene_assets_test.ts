import {
  build_asset_manifest,
  serialize_asset_manifest,
} from "@ink/assets/build.ts";
import { asset_id } from "@ink/assets/identity.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { SceneAssetStore } from "./scene_assets.ts";

Deno.test("scene assets load by identity and retain the last atomic revision after failure", async () => {
  let cube = new TextEncoder().encode("cube-one");
  let manifest = await build_asset_manifest([{
    id: "cube.obj",
    kind: "obj",
    bytes: cube,
  }], "memory manifest");
  const artifacts = new Map(
    manifest.artifacts.map(({ location, bytes }) => [location, bytes]),
  );
  const store = new SceneAssetStore({
    name: "memory manifest",
    read_manifest: () =>
      Promise.resolve(serialize_asset_manifest(manifest.manifest)),
    artifacts: {
      read(location) {
        const bytes = artifacts.get(location);
        if (bytes === undefined) throw new Error(`missing ${location}`);
        return Promise.resolve(bytes);
      },
    },
  });
  const resources = [{
    type: "mesh" as const,
    id: 4,
    asset: asset_id<"mesh">("cube.obj"),
  }];

  assertEquals((await store.replace(resources)).meshes[0].bytes, cube);

  cube = new TextEncoder().encode("cube-two");
  manifest = await build_asset_manifest([{
    id: "cube.obj",
    kind: "obj",
    bytes: cube,
  }], "memory manifest");
  artifacts.set(
    manifest.artifacts[0].location,
    new TextEncoder().encode("corrupt"),
  );
  await assertRejects(
    () => store.replace(resources),
    Error,
    "artifact byte size 7 does not match manifest byte size 8",
  );

  const original = await build_asset_manifest([{
    id: "cube.obj",
    kind: "obj",
    bytes: new TextEncoder().encode("cube-one"),
  }], "memory manifest");
  manifest = original;
  assertEquals(
    new TextDecoder().decode((await store.replace(resources)).meshes[0].bytes),
    "cube-one",
  );
});

Deno.test("scene assets reject identities absent from the manifest", async () => {
  const manifest = await build_asset_manifest([], "empty manifest");
  const store = new SceneAssetStore({
    name: "empty manifest",
    read_manifest: () =>
      Promise.resolve(serialize_asset_manifest(manifest.manifest)),
    artifacts: { read: () => Promise.reject(new Error("unexpected read")) },
  });
  await assertRejects(
    () =>
      store.replace([{
        type: "texture",
        id: 2,
        asset: asset_id<"texture">("missing.png"),
      }]),
    Error,
    'references missing asset "missing.png"',
  );
});
