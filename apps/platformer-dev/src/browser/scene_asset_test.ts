import { asset_id } from "@ink/assets/identity.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { PlatformerSceneAssetStore } from "./scene_asset.ts";

const generated_directory = new URL("../../generated/", import.meta.url);
const resource = {
  type: "mesh" as const,
  id: 0,
  asset: asset_id<"mesh">("cube.obj"),
};

Deno.test("platformer scene assets load the content-addressed mesh through a lease", async () => {
  const store = new PlatformerSceneAssetStore({
    name: "generated platformer assets",
    read_manifest: () =>
      Deno.readTextFile(new URL("assets.manifest.json", generated_directory)),
    artifacts: {
      read: (location) => Deno.readFile(new URL(location, generated_directory)),
    },
  });

  const first = await store.replace(resource);
  const second = await store.replace(resource);
  assertEquals(first.id, 0);
  assertEquals(first.model.vertex_count > 0, true);
  assertEquals(second.model.vertices, first.model.vertices);
});

Deno.test("platformer scene assets reject bytes that disagree with the manifest", async () => {
  const store = new PlatformerSceneAssetStore({
    name: "corrupt platformer assets",
    read_manifest: () =>
      Deno.readTextFile(new URL("assets.manifest.json", generated_directory)),
    artifacts: { read: () => Promise.resolve(new Uint8Array([0])) },
  });

  await assertRejects(
    () => store.replace(resource),
    Error,
    "did not load: artifact byte size 1 does not match manifest byte size",
  );
});
