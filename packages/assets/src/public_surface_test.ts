import { assertEquals } from "@std/assert";

Deno.test("assets publishes proven stable and explicitly experimental subpaths", async () => {
  const source = await Deno.readTextFile(
    new URL("../package.json", import.meta.url),
  );
  const manifest: unknown = JSON.parse(source);
  if (!is_record(manifest) || !is_record(manifest.exports)) {
    throw new Error("@ink/assets package.json exports must be an object");
  }

  assertEquals(manifest.exports, {
    "./build.ts": "./src/build.ts",
    "./bundle.ts": "./src/bundle.ts",
    "./cache.ts": "./src/cache.ts",
    "./digest.ts": "./src/digest.ts",
    "./experimental/gltf.ts": "./src/experimental/gltf.ts",
    "./experimental/media.ts": "./src/experimental/media.ts",
    "./experimental/stream.ts": "./src/experimental/stream.ts",
    "./identity.ts": "./src/identity.ts",
    "./load.ts": "./src/load.ts",
    "./manifest.ts": "./src/manifest.ts",
    "./mesh.ts": "./src/mesh.ts",
    "./prepared_scene.ts": "./src/prepared_scene.ts",
  });
});

function is_record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
