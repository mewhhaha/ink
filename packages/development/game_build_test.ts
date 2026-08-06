import { assertEquals, assertRejects } from "@std/assert";
import { pathToFileURL } from "node:url";
import { build_ink_game } from "./game_build.ts";
import { parse_asset_manifest } from "@ink/assets/manifest.ts";

Deno.test("Ink game builds publish artifacts and nested assets", async () => {
  const temporary_directory = pathToFileURL(`${await Deno.makeTempDir()}/`);
  try {
    const app_directory = new URL("app/", temporary_directory);
    const entrypoint = new URL("blot/game/main.blot", app_directory);
    const assets_directory = new URL("assets/", app_directory);
    const nested_assets_directory = new URL("terrain/", assets_directory);
    const public_directory = new URL("generated/", app_directory);
    const compiler = new URL("compiler.ts", temporary_directory);
    await Deno.mkdir(new URL("blot/game/", app_directory), {
      recursive: true,
    });
    await Deno.mkdir(nested_assets_directory, { recursive: true });
    await Deno.writeTextFile(entrypoint, "return 0;");
    await Deno.writeTextFile(
      new URL("ground.webp", nested_assets_directory),
      "ground texture",
    );
    await Deno.writeTextFile(
      compiler,
      `const entrypoint = Deno.args.at(-1);
if (!entrypoint) throw new Error("missing entrypoint");
const output = entrypoint.slice(0, -".blot".length) + ".wasm";
await Deno.writeTextFile(output, "compiled game");
await Deno.writeTextFile(output + ".json", "compiled manifest");
`,
    );

    await build_ink_game({
      artifact_name: "example",
      assets_directory,
      compiler,
      entrypoint,
      public_directory,
      working_directory: app_directory,
    });

    assertEquals(
      await Deno.readTextFile(new URL("example.wasm", public_directory)),
      "compiled game",
    );
    assertEquals(
      await Deno.readTextFile(
        new URL("example.wasm.json", public_directory),
      ),
      "compiled manifest",
    );
    assertEquals(
      await Deno.readTextFile(
        new URL("assets/terrain/ground.webp", public_directory),
      ),
      "ground texture",
    );
    const asset_manifest_source = await Deno.readTextFile(
      new URL("assets.manifest.json", public_directory),
    );
    const asset_manifest = parse_asset_manifest(
      JSON.parse(asset_manifest_source),
      "assets.manifest.json",
    );
    if (asset_manifest.type !== "ready") throw new Error(asset_manifest.reason);
    assertEquals(asset_manifest.manifest.assets.map((asset) => asset.id), [
      "terrain/ground.webp",
    ]);
    const content_location = asset_manifest.manifest.assets[0].location;
    assertEquals(
      await Deno.readTextFile(new URL(content_location, public_directory)),
      "ground texture",
    );
    await assertRejects(
      () => Deno.stat(new URL("blot/game/main.wasm", app_directory)),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(temporary_directory, { recursive: true });
  }
});
