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

Deno.test("nested Blot nodes derive parentage from lexical scene structure", async () => {
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
});
