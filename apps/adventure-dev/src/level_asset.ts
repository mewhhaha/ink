import { asset_id } from "@ink/assets/identity.ts";
import { load_artifact } from "@ink/assets/load.ts";
import { manifest_entry, parse_asset_manifest } from "@ink/assets/manifest.ts";

const adventure_level_asset = asset_id("levels/starter.json");

export async function load_adventure_level_source(
  public_directory: URL,
): Promise<string> {
  const manifest_path = new URL("assets.manifest.json", public_directory);
  const manifest_source = await Deno.readTextFile(manifest_path);
  let manifest_value: unknown;
  try {
    manifest_value = JSON.parse(manifest_source);
  } catch (cause) {
    throw new Error(
      `adventure asset manifest ${
        JSON.stringify(manifest_path.href)
      } is not valid JSON`,
      { cause },
    );
  }
  const parsed = parse_asset_manifest(manifest_value, manifest_path.href);
  if (parsed.type === "invalid_manifest") {
    throw new Error(
      `adventure asset manifest ${JSON.stringify(parsed.source)} field ${
        JSON.stringify(parsed.field)
      } is invalid: ${parsed.reason}`,
    );
  }
  const level_entry = manifest_entry(parsed.manifest, adventure_level_asset);
  if (level_entry === undefined) {
    throw new Error(
      `adventure asset manifest ${
        JSON.stringify(manifest_path.href)
      } does not contain ${JSON.stringify(adventure_level_asset)}`,
    );
  }
  if (level_entry.kind !== "json") {
    throw new Error(
      `adventure level asset ${JSON.stringify(level_entry.id)} has kind ${
        JSON.stringify(level_entry.kind)
      }; expected "json"`,
    );
  }
  if (level_entry.dependencies.length !== 0) {
    throw new Error(
      `adventure level asset ${
        JSON.stringify(level_entry.id)
      } declares ${level_entry.dependencies.length} dependencies; expected a standalone Blot integer asset`,
    );
  }
  const expected_location = `assets/.ink/${
    level_entry.digest.slice("sha256:".length)
  }`;
  if (level_entry.location !== expected_location) {
    throw new Error(
      `adventure level asset ${JSON.stringify(level_entry.id)} location ${
        JSON.stringify(level_entry.location)
      } is not its digest-addressed location ${
        JSON.stringify(expected_location)
      }`,
    );
  }
  const loaded = await load_artifact(level_entry, {
    read(location) {
      return Deno.readFile(new URL(location, public_directory));
    },
  });
  if (loaded.type !== "ready") {
    throw new Error(
      `adventure level asset ${
        JSON.stringify(adventure_level_asset)
      } did not load: ${
        loaded.type === "failed" ? loaded.reason : "cancelled"
      }`,
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(loaded.bytes);
  } catch (cause) {
    throw new Error(
      `adventure level asset ${
        JSON.stringify(adventure_level_asset)
      } is not UTF-8`,
      { cause },
    );
  }
}
