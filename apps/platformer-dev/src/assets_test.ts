import {
  build_asset_manifest,
  serialize_asset_manifest,
} from "@ink/assets/build.ts";
import type { ArtifactReader } from "@ink/assets/load.ts";
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  load_platformer_level_asset,
  type PlatformerAssetSource,
} from "./assets.ts";

const level_source = '{"format":"blot-integer-data","version":1}\n';

Deno.test("platformer level loading reads the manifest's digest-addressed artifact", async () => {
  const fixture = await level_fixture();
  const reads: string[] = [];

  const loaded = await load_platformer_level_asset(
    fixture_source(fixture, reads),
  );

  assertEquals(loaded, level_source);
  assertEquals(reads, [fixture.location]);
  assertStringIncludes(fixture.location, "assets/.ink/");
  assertEquals(reads.includes("assets/levels/first-steps.json"), false);
});

Deno.test("platformer level loading rejects bytes that do not match the manifest digest", async () => {
  const fixture = await level_fixture();
  const corrupted = new TextEncoder().encode(
    level_source.replace('version":1', 'version":2'),
  );
  const source = fixture_source(fixture, [], {
    read() {
      return Promise.resolve(corrupted);
    },
  });

  await assertRejects(
    () => load_platformer_level_asset(source),
    Error,
    "does not match manifest digest",
  );
});

Deno.test("platformer level loading rejects a raw alias in the manifest", async () => {
  const fixture = await level_fixture();
  const reads: string[] = [];
  const raw_alias = "assets/levels/first-steps.json";
  const raw_alias_manifest_source = fixture.manifest_source.replace(
    JSON.stringify(fixture.location),
    JSON.stringify(raw_alias),
  );
  const source = fixture_source({
    ...fixture,
    manifest_source: raw_alias_manifest_source,
  }, reads);

  await assertRejects(
    () => load_platformer_level_asset(source),
    Error,
    "is not its digest-addressed location",
  );
  assertEquals(reads, []);
});

interface LevelFixture {
  readonly bytes: Uint8Array;
  readonly location: string;
  readonly manifest_source: string;
}

async function level_fixture(): Promise<LevelFixture> {
  const build = await build_asset_manifest([{
    id: "levels/first-steps.json",
    kind: "json",
    bytes: new TextEncoder().encode(level_source),
  }], "assets.manifest.json");
  return {
    bytes: build.artifacts[0].bytes,
    location: build.artifacts[0].location,
    manifest_source: serialize_asset_manifest(build.manifest),
  };
}

function fixture_source(
  fixture: LevelFixture,
  reads: string[],
  reader?: ArtifactReader,
): PlatformerAssetSource {
  return {
    name: "assets.manifest.json",
    read_manifest: () => Promise.resolve(fixture.manifest_source),
    artifacts: reader ?? {
      read(location) {
        reads.push(location);
        if (location !== fixture.location) {
          throw new Error(
            `platformer fixture does not contain ${JSON.stringify(location)}`,
          );
        }
        return Promise.resolve(fixture.bytes);
      },
    },
  };
}
