import { assertEquals } from "@std/assert";
import { create_blot_guest } from "./src/guest.ts";
import { parse_blot_manifest } from "./src/manifest.ts";

const decoder = new TextDecoder();
const blot_cli = new URL("../../../blot/src/cli.ts", import.meta.url);
const fixture = new URL(
  "./testdata/scene_tree_contract.blot",
  import.meta.url,
);
const wasm_artifact = new URL(
  "./testdata/scene_tree_contract.wasm",
  import.meta.url,
);
const manifest_artifact = new URL(
  "./testdata/scene_tree_contract.wasm.json",
  import.meta.url,
);

Deno.test("nested Blot nodes preserve parentage and local surface materials", async () => {
  const build = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      blot_cli.pathname,
      "build",
      fixture.pathname,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!build.success) {
    throw new Error(
      `Blot scene-tree fixture exited with code ${build.code}: ${
        decoder.decode(build.stderr).trim()
      }`,
    );
  }

  const [wasm_bytes, manifest_source] = await Promise.all([
    Deno.readFile(wasm_artifact),
    Deno.readTextFile(manifest_artifact),
  ]);
  await Promise.all([
    Deno.remove(wasm_artifact),
    Deno.remove(manifest_artifact),
  ]);
  const guest = await create_blot_guest(
    wasm_bytes,
    parse_blot_manifest(manifest_source),
  );
  const rendered = guest.render(
    { scalar: 0n, cells: [] },
    { width: 1280, height: 720 },
  );

  assertEquals(rendered.nodes.map(({ id, parent }) => ({ id, parent })), [
    { id: 10, parent: null },
  ]);
  assertEquals(rendered.objects.map(({ id, parent }) => ({ id, parent })), [
    { id: 11, parent: 10 },
    { id: 12, parent: 11 },
  ]);
  assertEquals(
    rendered.objects.map((object) => ({
      blend_edges: object.blend_edges,
      color: object.color,
      emissive: object.emissive,
      path_connections: object.path_connections,
      secondary_texture: object.secondary_texture,
      surface_mode: object.surface_mode,
      texture: object.texture,
      texture_offset: object.texture_offset,
      texture_scale: object.texture_scale,
      variation_seed: object.variation_seed,
    })),
    [
      {
        blend_edges: 0,
        color: [1, 0, 0],
        emissive: 0,
        path_connections: 0,
        secondary_texture: null,
        surface_mode: 3,
        texture: null,
        texture_offset: [0, 0],
        texture_scale: [1, 1],
        variation_seed: 0,
      },
      {
        blend_edges: 0,
        color: [0, 1, 0],
        emissive: 0,
        path_connections: 0,
        secondary_texture: null,
        surface_mode: 0,
        texture: null,
        texture_offset: [0, 0],
        texture_scale: [1, 1],
        variation_seed: 0,
      },
    ],
  );
});
