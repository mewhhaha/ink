import { assertEquals } from "@std/assert";
import { blot_abi_registry, blot_host_import_key } from "./src/abi.ts";
import { parse_blot_manifest } from "./src/manifest.ts";

const decoder = new TextDecoder();
const blot_cli = new URL("../../../blot/src/cli.ts", import.meta.url);
const fixture = new URL(
  "./testdata/abi_registry_contract.blot",
  import.meta.url,
);
const wasm_artifact = new URL(
  "./testdata/abi_registry_contract.wasm",
  import.meta.url,
);
const manifest_artifact = new URL(
  "./testdata/abi_registry_contract.wasm.json",
  import.meta.url,
);

Deno.test("generated Blot ABI fixture covers every registered host operation", async () => {
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
      `Blot ABI registry fixture exited with code ${build.code}: ${
        decoder.decode(build.stderr).trim()
      }`,
    );
  }

  try {
    const manifest = parse_blot_manifest(
      await Deno.readTextFile(manifest_artifact),
    );
    assertEquals(
      manifest.imports.map(blot_host_import_key).sort(),
      blot_abi_registry.host_imports.map(blot_host_import_key).sort(),
    );
  } finally {
    await Promise.all([
      Deno.remove(wasm_artifact),
      Deno.remove(manifest_artifact),
    ]);
  }
});
