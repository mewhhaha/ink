import { assertEquals } from "@std/assert";
import type { ArtifactReader } from "@ink/assets/load.ts";
import { LightingReferenceAssets } from "./reference_assets.ts";

Deno.test("lighting runtime loads prepared digest artifacts without reading a source GLB", async () => {
  const requests: string[] = [];
  const public_root = new URL("../generated/public/", import.meta.url);
  const reader: ArtifactReader = {
    async read(location): Promise<Uint8Array> {
      requests.push(location);
      const relative_location = location.startsWith("/")
        ? location.slice(1)
        : location;
      return await Deno.readFile(new URL(relative_location, public_root));
    },
  };
  const references = await LightingReferenceAssets.create(reader);
  const loaded = await references.load("fog-room");

  assertEquals(loaded.scene.meshes.length, 1);
  assertEquals(loaded.scene.textures.length, 1);
  assertEquals(
    requests.every((location) =>
      location === "/prepared/catalog.json" ||
      location.startsWith("/prepared/manifests/") ||
      location.startsWith("assets/.ink/")
    ),
    true,
  );
  assertEquals(
    requests.some((location) => location.toLowerCase().endsWith(".glb")),
    false,
  );
});
