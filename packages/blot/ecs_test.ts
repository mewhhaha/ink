import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { create_blot_guest } from "./src/guest.ts";
import { parse_blot_manifest } from "./src/manifest.ts";

const decoder = new TextDecoder();
const blot_cli = new URL("../../../blot/src/cli.ts", import.meta.url);

async function compile_rejection(
  name: string,
): Promise<string> {
  const rejected_fixture = new URL(`./testdata/${name}.blot`, import.meta.url);
  const built = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      blot_cli.pathname,
      "build",
      rejected_fixture.pathname,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(built.success, false);
  return decoder.decode(built.stderr);
}

async function compile_guest(name: string) {
  const fixture = new URL(`./testdata/${name}.blot`, import.meta.url);
  const wasm_artifact = new URL(`./testdata/${name}.wasm`, import.meta.url);
  const manifest_artifact = new URL(
    `./testdata/${name}.wasm.json`,
    import.meta.url,
  );
  const built = await new Deno.Command(Deno.execPath(), {
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
  if (!built.success) {
    throw new Error(
      `Blot fixture ${JSON.stringify(name)} exited with code ${built.code}: ${
        decoder.decode(built.stderr).trim()
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
  return await create_blot_guest(
    wasm_bytes,
    parse_blot_manifest(manifest_source),
  );
}

async function compile_acceptance(name: string): Promise<void> {
  await compile_guest(name);
}

Deno.test("ECS components register, query, update, remove, and survive entity reuse", async () => {
  const guest = await compile_guest("ecs_contract");
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
        resource_capacity: 1,
        resource_stride: 2,
      },
      components: [
        { field_count: 2, fields: "x:Int;y:Int", id: 0, name: "Position" },
        { field_count: 2, fields: "x:Int;y:Int", id: 1, name: "Velocity" },
      ],
      seeds: [],
      resources: [
        {
          field_count: 1,
          fields: "value:Int",
          id: 0,
          name: "Counter",
          source: "7",
        },
      ],
    }),
  );

  const started = guest.start();
  assertEquals(started.scalar, 0n);
  assertEquals(guest.step(started, 9, 0, 0, 16_667).scalar, 7n);
  const counter_updated = guest.step(started, 8, 42, 0, 16_667);
  assertEquals(guest.step(counter_updated, 9, 0, 0, 16_667).scalar, 42n);
  assertEquals(guest.step(started, 6, 0, 0, 16_667).scalar, 1n);
  assertEquals(guest.step(started, 7, 0, 0, 16_667).scalar, 1_318n);
  const updated = guest.step(started, 1, 0, 0, 16_667);
  assertEquals(guest.step(updated, 2, 0, 0, 16_667).scalar, 2_618n);

  const removed = guest.step(updated, 5, 0, 0, 16_667);
  assertEquals(guest.step(removed, 6, 0, 0, 16_667).scalar, 0n);
  assertEquals(guest.step(removed, 2, 0, 0, 16_667).scalar, -1n);
  assertEquals(guest.step(removed, 1, 0, 0, 16_667).scalar, -1n);

  const despawned = guest.step(updated, 3, 0, 0, 16_667);
  assertEquals(guest.step(despawned, 6, 0, 0, 16_667).scalar, 1n);
  assertEquals(guest.step(despawned, 2, 0, 0, 16_667).scalar, -1n);
  const reused = guest.step(despawned, 4, 0, 0, 16_667);
  assertEquals(reused.scalar, 100n);
  assertEquals(guest.step(reused, 2, 0, 0, 16_667).scalar, -1n);
  assertEquals(guest.step(reused, 2, 4, 0, 16_667).scalar, -1n);
});

Deno.test("ECS components reject payloads without required fields", async () => {
  const diagnostic = await compile_rejection("ecs_wrong_payload");
  assertStringIncludes(diagnostic, "No field `y`");
});

Deno.test("ECS components reject fields absent from their declaration", async () => {
  const diagnostic = await compile_rejection("ecs_unknown_field");
  assertStringIncludes(diagnostic, "missing field z");
});

Deno.test("ECS resources reject payloads without required fields", async () => {
  const diagnostic = await compile_rejection("ecs_wrong_resource");
  assertStringIncludes(diagnostic, "No field `value`");
});

Deno.test("ECS worlds hide undeclared components", async () => {
  await compile_rejection("ecs_unknown_store");
});

Deno.test("ECS component operations survive colliding field names", async () => {
  await compile_acceptance("ecs_reserved_component");
});

Deno.test("ECS resource operations survive colliding field names", async () => {
  await compile_acceptance("ecs_reserved_resource");
});

Deno.test("read-only system scopes omit component mutations", async () => {
  const diagnostic = await compile_rejection("ecs_readonly_write");
  assertStringIncludes(diagnostic, "missing field insert");
});

Deno.test("ECS cells preserve Boolean and sealed component fields", async () => {
  const guest = await compile_guest("ecs_bool");
  assertStringIncludes(guest.state_schema, "active:Bool");
  assertStringIncludes(guest.state_schema, "layer:Sealed(test.Layer,Int)");
  const started = guest.start();
  assertEquals(guest.step(started, 0, 0, 0, 16_667).scalar, 7n);
});

Deno.test("cell access rejects invalid indices", async () => {
  const guest = await compile_guest("invalid_cell");
  assertThrows(
    () => guest.start(),
    Error,
    "Blot cell index -1 is not a non-negative safe integer",
  );
});

Deno.test("cell writes reject invalid indices", async () => {
  const guest = await compile_guest("invalid_cell_put");
  assertThrows(
    () => guest.start(),
    Error,
    "Blot cell index -1 is not a non-negative safe integer",
  );
});
