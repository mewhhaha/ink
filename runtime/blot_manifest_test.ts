import { assertEquals, assertThrows } from "@std/assert";
import { parse_blot_manifest } from "./blot_manifest.ts";

Deno.test("compiled Blot manifests parse their complete ABI types", async () => {
  const source = await Deno.readTextFile(
    new URL("../generated/scene_explorer.wasm.json", import.meta.url),
  );

  const manifest = parse_blot_manifest(source);

  assertEquals(manifest.exports.map((entry) => entry.sourceName), [
    "init",
    "step",
    "observe",
    "prepare_render",
    "render",
  ]);
  assertEquals(
    manifest.imports.map((entry) => `${entry.module}.${entry.name}`).sort(),
    [
      "blot:host/Render.beacon",
      "blot:host/Render.projection",
      "blot:host/Semantic.region",
      "blot:host/Semantic.status",
    ],
  );
});

Deno.test("manifest parsing reports an invalid nested ABI type", async () => {
  const source = await Deno.readTextFile(
    new URL("../generated/scene_explorer.wasm.json", import.meta.url),
  );
  const manifest = JSON.parse(source);
  manifest.imports[0].function.parameters[0].fields[0].type.kind = "mystery";

  assertThrows(
    () => parse_blot_manifest(JSON.stringify(manifest)),
    Error,
    'game manifest imports[0].function.parameters[0].fields[0].type.kind "mystery" is not supported',
  );
});
