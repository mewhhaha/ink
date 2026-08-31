import { assertEquals } from "@std/assert";
import { create_blot_guest } from "./src/guest.ts";
import { parse_blot_manifest } from "./src/manifest.ts";

const decoder = new TextDecoder();
const blot_cli = new URL("../../../blot/src/cli.ts", import.meta.url);
const fixture = new URL("./testdata/ecs_contract.blot", import.meta.url);
const wasm_artifact = new URL("./testdata/ecs_contract.wasm", import.meta.url);
const manifest_artifact = new URL(
  "./testdata/ecs_contract.wasm.json",
  import.meta.url,
);

Deno.test("ECS components register, query, update, remove, and survive entity reuse", async () => {
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
      `Blot ECS fixture exited with code ${build.code}: ${
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
  assertEquals(
    guest.state_schema,
    JSON.stringify({
      world: {
        base: 0,
        capacity: 4,
        component_base: 14,
        component_capacity: 2,
        component_stride: 21,
        entity_metadata_base: 2,
        entity_mode: 0,
        max_fields: 2,
        resource_base: 56,
        resource_capacity: 0,
        resource_stride: 2,
      },
      components: [
        { field_count: 2, fields: "x:Int;y:Int", id: 0, name: "Position" },
        { field_count: 2, fields: "x:Int;y:Int", id: 1, name: "Velocity" },
      ],
      seeds: [],
      resources: [],
    }),
  );

  const started = guest.start();
  assertEquals(started.scalar, 0n);
  assertEquals(guest.step(started, 6, 0, 0, 16_667).state.scalar, 1n);
  assertEquals(guest.step(started, 7, 0, 0, 16_667).state.scalar, 1_318n);
  const updated = guest.step(started, 1, 0, 0, 16_667).state;
  assertEquals(guest.step(updated, 2, 0, 0, 16_667).state.scalar, 2_618n);

  const removed = guest.step(updated, 5, 0, 0, 16_667).state;
  assertEquals(guest.step(removed, 6, 0, 0, 16_667).state.scalar, 0n);
  assertEquals(guest.step(removed, 2, 0, 0, 16_667).state.scalar, -1n);
  assertEquals(guest.step(removed, 1, 0, 0, 16_667).state.scalar, -1n);

  const despawned = guest.step(updated, 3, 0, 0, 16_667).state;
  assertEquals(guest.step(despawned, 6, 0, 0, 16_667).state.scalar, 1n);
  assertEquals(guest.step(despawned, 2, 0, 0, 16_667).state.scalar, -1n);
  const reused = guest.step(despawned, 4, 0, 0, 16_667).state;
  assertEquals(reused.scalar, 100n);
  assertEquals(guest.step(reused, 2, 0, 0, 16_667).state.scalar, -1n);
  assertEquals(guest.step(reused, 2, 4, 0, 16_667).state.scalar, -1n);
});
