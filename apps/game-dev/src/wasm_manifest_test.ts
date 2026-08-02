import { assertEquals } from "@std/assert";
import { parse_blot_manifest } from "@ink/blot/manifest.ts";

Deno.test("the compiled game manifest exposes the supported ABI", async () => {
  const source = await Deno.readTextFile(
    new URL("../generated/game_development.wasm.json", import.meta.url),
  );

  const manifest = parse_blot_manifest(source);

  assertEquals(manifest.exports.map((entry) => entry.sourceName), ["step"]);
  assertEquals(
    manifest.imports.map((entry) => `${entry.module}.${entry.name}`).sort(),
    [
      "blot:host/Events.next",
      "blot:host/Phase.current",
      "blot:host/Render.mesh",
      "blot:host/Render.object",
      "blot:host/Render.projection",
      "blot:host/Semantic.element",
      "blot:host/Semantic.status",
      "blot:host/State.commit",
      "blot:host/State.current",
    ],
  );
});
