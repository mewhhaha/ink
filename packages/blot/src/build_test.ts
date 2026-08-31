import { assert, assertEquals, assertRejects } from "@std/assert";
import { pathToFileURL } from "node:url";
import {
  build_blot_game,
  create_blot_development_build,
  create_serial_blot_project_publisher,
  publish_blot_assets,
} from "./build.ts";
import { parse_asset_manifest } from "@ink/assets/manifest.ts";
import { parse_blot_development_revision } from "./development.ts";

Deno.test("Ink game builds publish digest-addressed assets", async () => {
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
    await assertRejects(
      () =>
        Deno.stat(
          new URL("assets/terrain/ground.webp", public_directory),
        ),
      Deno.errors.NotFound,
    );
    await assertRejects(
      () =>
        Deno.stat(
          new URL("assets/levels/starter.json", public_directory),
        ),
      Deno.errors.NotFound,
    );
    assertEquals(
      await Deno.readTextFile(
        new URL(
          asset_manifest.manifest.assets[0].location,
          public_directory,
        ),
      ),
      "generated level",
    );
    assertEquals(
      await Deno.readTextFile(
        new URL(
          asset_manifest.manifest.assets[1].location,
          public_directory,
        ),
      ),
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

Deno.test("generated-only game builds publish no source asset directory", async () => {
  const temporary_directory = pathToFileURL(
    `${await Deno.makeTempDir({ dir: "testdata" })}/`,
  );
  try {
    const app_directory = new URL("app/", temporary_directory);
    const entrypoint = new URL("blot/game/main.blot", app_directory);
    const public_directory = new URL("generated/", app_directory);
    const compiler = new URL("compiler.ts", temporary_directory);
    await Deno.mkdir(new URL("blot/game/", app_directory), {
      recursive: true,
    });
    await Deno.writeTextFile(entrypoint, "return 0;");
    await Deno.mkdir(new URL("assets/.ink/", public_directory), {
      recursive: true,
    });
    await Deno.writeTextFile(
      new URL("assets/.ink/stale-source", public_directory),
      "v 0 0 0\nf 1 2 3\n",
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
      artifact_name: "prepared-example",
      compiler,
      entrypoint,
      generated_assets: [{
        id: "adventure/render/scene",
        kind: "prepared-static-scene",
        bytes: new Uint8Array([1, 2, 3]),
      }],
      public_directory,
      working_directory: app_directory,
    });

    await assertRejects(
      () => Deno.stat(new URL("assets/cube.obj", public_directory)),
      Deno.errors.NotFound,
    );
    await assertRejects(
      () =>
        Deno.stat(
          new URL("assets/.ink/stale-source", public_directory),
        ),
      Deno.errors.NotFound,
    );
    const manifest_source = await Deno.readTextFile(
      new URL("assets.manifest.json", public_directory),
    );
    const parsed = parse_asset_manifest(
      JSON.parse(manifest_source),
      "assets.manifest.json",
    );
    if (parsed.type !== "ready") throw new Error(parsed.reason);
    assertEquals(parsed.manifest.assets.map(({ id }) => id), [
      "adventure/render/scene",
    ]);
  } finally {
    await Deno.remove(temporary_directory, { recursive: true });
  }
});

Deno.test("asset publication replaces the manifest and prunes superseded content", async () => {
  const temporary_directory = pathToFileURL(
    `${await Deno.makeTempDir({ dir: "testdata" })}/`,
  );
  try {
    const public_directory = new URL("generated/", temporary_directory);
    await publish_blot_assets({
      generated_assets: [{
        id: "levels/starter.json",
        kind: "json",
        bytes: new Uint8Array([1, 2, 3]),
      }],
      public_directory,
    });
    const first_manifest = parse_asset_manifest(
      JSON.parse(
        await Deno.readTextFile(
          new URL("assets.manifest.json", public_directory),
        ),
      ),
      "assets.manifest.json",
    );
    if (first_manifest.type !== "ready") {
      throw new Error(first_manifest.reason);
    }
    const first_location = first_manifest.manifest.assets[0].location;

    await publish_blot_assets({
      generated_assets: [{
        id: "levels/starter.json",
        kind: "json",
        bytes: new Uint8Array([4, 5, 6]),
      }],
      public_directory,
    });
    const second_manifest = parse_asset_manifest(
      JSON.parse(
        await Deno.readTextFile(
          new URL("assets.manifest.json", public_directory),
        ),
      ),
      "assets.manifest.json",
    );
    if (second_manifest.type !== "ready") {
      throw new Error(second_manifest.reason);
    }
    const second_location = second_manifest.manifest.assets[0].location;

    assert(first_location !== second_location);
    await assertRejects(
      () =>
        Deno.stat(
          new URL("assets/levels/starter.json", public_directory),
        ),
      Deno.errors.NotFound,
    );
    assertEquals(
      await Deno.readFile(new URL(second_location, public_directory)),
      new Uint8Array([4, 5, 6]),
    );
    await assertRejects(
      () => Deno.stat(new URL(first_location, public_directory)),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(temporary_directory, { recursive: true });
  }
});

Deno.test("serial project publication preserves order and recovers after a rejection", async () => {
  const events: string[] = [];
  let release_first: (() => void) | undefined;
  const first_gate = new Promise<void>((resolve) => {
    release_first = resolve;
  });
  let attempt = 0;
  const publish = create_serial_blot_project_publisher(async () => {
    const current_attempt = attempt;
    attempt += 1;
    events.push(`start:${current_attempt}`);
    if (current_attempt === 0) await first_gate;
    if (current_attempt === 1) throw new Error("revision 1 rejected");
    events.push(`finish:${current_attempt}`);
  });

  const first = publish();
  const rejected_second = assertRejects(
    () => publish(),
    Error,
    "revision 1 rejected",
  );
  await Promise.resolve();
  assertEquals(events, ["start:0"]);
  if (release_first === undefined) {
    throw new Error("serial project publication did not start revision 0");
  }
  release_first();
  await first;
  await rejected_second;
  await publish();

  assertEquals(events, [
    "start:0",
    "finish:0",
    "start:1",
    "start:2",
    "finish:2",
  ]);
});

Deno.test("development builds publish exact two-unit deltas and retry aborted publication", async () => {
  const temporary_directory = pathToFileURL(
    `${await Deno.makeTempDir({ dir: "testdata" })}/`,
  );
  try {
    const public_directory = new URL("generated/", temporary_directory);
    const entrypoint = new URL("main.blot", temporary_directory);
    const provider = new URL("provider.blot", temporary_directory);
    const project_manifest = new URL("blot.json", temporary_directory);
    await Promise.all([
      Deno.writeTextFile(
        entrypoint,
        development_entry_source(),
      ),
      Deno.writeTextFile(provider, development_provider_source("")),
      Deno.writeTextFile(
        project_manifest,
        JSON.stringify({
          schema: "blot-project",
          version: 1,
          entryUnit: "game",
          units: {
            game: "./main.blot",
            provider: "./provider.blot",
          },
        }),
      ),
    ]);
    const development = create_blot_development_build({
      artifact_name: "example",
      compiler_distribution: {
        wasm: new URL(
          "../../../../blot/compiler/target/development-profile/compiler.wasm",
          import.meta.url,
        ),
        prelude_snapshot: new URL(
          "../../../../blot/compiler/target/development-profile/prelude.snapshot",
          import.meta.url,
        ),
      },
      project_manifest,
      public_directory,
    });

    await development.run({ type: "initial" });
    const initial = parse_blot_development_revision(
      JSON.parse(
        await Deno.readTextFile(
          new URL("example.development.json", public_directory),
        ),
      ),
    );
    assertEquals(
      initial.snapshot_units.map(({ name }) => name),
      ["game", "provider"],
    );
    assertEquals(
      initial.delta.changed_units.map(({ name }) => name),
      ["game", "provider"],
    );
    assertEquals(initial.delta.retained_units, []);
    for (const unit of initial.snapshot_units) {
      assert(
        (await Deno.stat(new URL(unit.wasm_path, public_directory))).isFile,
      );
      assert(
        (await Deno.stat(new URL(unit.manifest_path, public_directory))).isFile,
      );
    }

    await Deno.writeTextFile(
      provider,
      development_provider_source(", request.seed"),
    );
    await development.run({
      type: "sources",
      changes: [{ path: provider.pathname, type: "update" }],
    });
    const edited = parse_blot_development_revision(
      JSON.parse(
        await Deno.readTextFile(
          new URL("example.development.json", public_directory),
        ),
      ),
    );
    assertEquals(
      edited.delta.changed_units.map(({ name }) => name),
      ["provider"],
    );
    assertEquals(
      edited.delta.retained_units.map(({ name }) => name),
      ["game"],
    );
    assertEquals(edited.delta.base_revision, initial.revision);
    assertEquals(
      edited.snapshot_units.map(({ name }) => name),
      ["game", "provider"],
    );

    await Deno.writeTextFile(
      provider,
      development_provider_source(", request.seed, request.seed"),
    );
    const descriptor = new URL("example.development.json", public_directory);
    const last_good_descriptor = await Deno.readFile(descriptor);
    await Deno.remove(descriptor);
    await Deno.mkdir(descriptor);
    await assertRejects(
      () =>
        development.run({
          type: "sources",
          changes: [{ path: provider.pathname, type: "update" }],
        }),
      Error,
    );
    await Deno.remove(descriptor, { recursive: true });
    await Deno.writeFile(descriptor, last_good_descriptor);
    await development.run({
      type: "sources",
      changes: [{ path: provider.pathname, type: "update" }],
    });
    const retried = parse_blot_development_revision(
      JSON.parse(await Deno.readTextFile(descriptor)),
    );
    assertEquals(retried.delta.base_revision, edited.revision);
    assertEquals(
      retried.delta.changed_units.map(({ name }) => name),
      ["provider"],
    );
    development.close();
  } finally {
    await Deno.remove(temporary_directory, { recursive: true });
  }
});

function development_entry_source(): string {
  return `open import "blot:prelude"
const codec = import "./provider.blot"
const Source = @effect.host { .value = Unit -> Int; }
use value <- Source.value ()
let values = [value, value + 1]
let response = codec.expand {
  .choice = #Some (value + 2);
  .label = "oak";
  .seed = value + 3;
  .values = values;
}
let first = case Array.get (response.values, 0) of
  #Some found => found
  #None => 0
let third = case Array.get (response.values, 2) of
  #Some found => found
  #None => 0
let chosen = case response.choice of
  #Some found => found
  #None => 0
let unchanged = case Array.get (values, 2) of
  #Some _ => 0
  #None => 100
return
  first + third + chosen + @text.len response.label + unchanged +
  Array.length response.values
`;
}

function development_provider_source(extra_seed: string): string {
  return `open import "blot:prelude"
let expand = fn request => {
  .choice = request.choice;
  .label = request.label;
  .values = [...request.values, request.seed${extra_seed}];
}
return { .expand = expand; }
`;
}
