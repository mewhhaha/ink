import { assertEquals, assertRejects } from "@std/assert";
import { pathToFileURL } from "node:url";
import { build_blot_game, create_blot_development_build } from "./build.ts";
import { parse_asset_manifest } from "@ink/assets/manifest.ts";

Deno.test("Ink game builds publish artifacts and nested assets", async () => {
  const temporary_directory = pathToFileURL(
    `${await Deno.makeTempDir({ dir: "testdata" })}/`,
  );
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

    await build_blot_game({
      artifact_name: "example",
      assets_directory,
      compiler,
      entrypoint,
      generated_assets: [{
        id: "levels/starter.json",
        kind: "json",
        bytes: new TextEncoder().encode("generated level"),
      }],
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
    assertEquals(
      await Deno.readTextFile(
        new URL("assets/levels/starter.json", public_directory),
      ),
      "generated level",
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
      "levels/starter.json",
      "terrain/ground.webp",
    ]);
    const content_location = asset_manifest.manifest.assets[1].location;
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

Deno.test("development builds retain their compiler and publish changed entry units", async () => {
  const temporary_directory = pathToFileURL(
    `${await Deno.makeTempDir({ dir: "testdata" })}/`,
  );
  try {
    const compiler_module = new URL("compiler.ts", temporary_directory);
    const public_directory = new URL("generated/", temporary_directory);
    const entrypoint = new URL("main.blot", temporary_directory);
    const project_manifest = new URL("blot.json", temporary_directory);
    await Deno.writeTextFile(entrypoint, "return 0;");
    await Deno.writeTextFile(project_manifest, "{}");
    await Deno.writeTextFile(
      compiler_module,
      `export class DevelopmentProject {
  builds = 0;
  static async create() { return new DevelopmentProject(); }
  async markChanged() {}
  async build() {
    this.builds += 1;
    return this.builds === 1
      ? {
        revision: "first-revision",
        durationMilliseconds: 4,
        entryUnit: "game",
        changedUnits: [{
          name: "game",
          wasm: new TextEncoder().encode("debug wasm"),
          manifestBytes: new TextEncoder().encode("debug manifest"),
        }],
        retainedUnits: [],
      }
      : {
        revision: "second-revision",
        durationMilliseconds: 1,
        entryUnit: "game",
        changedUnits: [],
        retainedUnits: [{ name: "game" }],
      };
  }
  destroy() {}
}`,
    );
    const development = create_blot_development_build({
      artifact_name: "example",
      compiler_module,
      entrypoint,
      project_manifest,
      public_directory,
    });

    await development.run();
    await development.run();
    development.close();

    assertEquals(
      await Deno.readTextFile(new URL("example.wasm", public_directory)),
      "debug wasm",
    );
    assertEquals(
      await Deno.readTextFile(
        new URL("example.wasm.json", public_directory),
      ),
      "debug manifest",
    );
  } finally {
    await Deno.remove(temporary_directory, { recursive: true });
  }
});
