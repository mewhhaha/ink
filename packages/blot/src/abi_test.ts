import { assertEquals, assertThrows } from "@std/assert";
import {
  blot_abi_contract_source,
  blot_abi_registry,
  blot_host_declarations_source,
  create_blot_host_import_modules,
  registered_blot_host_import,
} from "./abi.ts";
import { parse_blot_manifest } from "./manifest.ts";

Deno.test("generated Blot ABI sources match the registry", async () => {
  const [declarations, contract] = await Promise.all([
    Deno.readTextFile(new URL("../abi.blot", import.meta.url)),
    Deno.readTextFile(
      new URL("../testdata/abi_registry_contract.blot", import.meta.url),
    ),
  ]);

  assertEquals(declarations, blot_host_declarations_source());
  assertEquals(contract, blot_abi_contract_source());
});

Deno.test("Blot ABI codecs select canonical indirect calls", () => {
  assertEquals(
    registered_blot_host_import("Render", "orthogonal_tilemap").codec,
    {
      flat_parameters: Array<"i64">(11).fill("i64"),
      flat_result: [],
      wasm_parameters: Array<"i64">(11).fill("i64"),
      wasm_result: [],
      parameter_passing: "flat",
      result_passing: "none",
    },
  );
  assertEquals(registered_blot_host_import("Events", "next").codec, {
    flat_parameters: [],
    flat_result: ["i64", "i64", "i64"],
    wasm_parameters: ["i32"],
    wasm_result: [],
    parameter_passing: "flat",
    result_passing: "indirect",
  });
});

Deno.test("Blot host modules reject declarations outside the registry", () => {
  const implementations = registered_host_implementations();
  const cells = implementations.Cells;
  if (cells === undefined) throw new Error("test registry omitted Cells");
  cells.unknown = () => {};
  const memory = new WebAssembly.Memory({ initial: 1 });

  assertThrows(
    () =>
      create_test_host_modules(
        implementations,
        { memory: () => memory },
      ),
    Error,
    '"Cells.unknown"',
  );
});

Deno.test("Blot host codecs decode field names, order, and wire types from the registry", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const encoder = new TextEncoder();
  const write_text = (pointer: number, value: string): number => {
    const encoded = encoder.encode(value);
    new Uint8Array(memory.buffer, pointer, encoded.length).set(encoded);
    return encoded.length;
  };
  const description_length = write_text(64, "description");
  const id_length = write_text(96, "id");
  const label_length = write_text(128, "label");
  let received: unknown;
  const implementations = registered_host_implementations();
  const ui = implementations.Ui;
  if (ui === undefined) throw new Error("test registry omitted Ui");
  ui.element = (parameter: unknown) => {
    received = parameter;
  };
  const modules = create_test_host_modules(
    implementations,
    { memory: () => memory },
  );
  const element = modules["blot:host/Ui"]?.element;
  if (element === undefined) throw new Error("test modules omitted Ui.element");

  Reflect.apply(element, undefined, [
    64,
    description_length,
    101n,
    102n,
    96,
    id_length,
    103n,
    128,
    label_length,
    104n,
    105n,
    1,
    0,
    106n,
    107n,
  ]);

  assertEquals(received, {
    description: "description",
    element_height: 101n,
    element_width: 102n,
    id: "id",
    kind: 103n,
    label: "label",
    maximum: 104n,
    order: 105n,
    pressed: true,
    selected: false,
    target: 106n,
    value: 107n,
  });
});

Deno.test("Blot host codecs reject an unknown runtime product reference", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const implementations = registered_host_implementations();
  const modules = create_test_host_modules(implementations, {
    memory: () => memory,
    resolve_runtime_reference: () => undefined,
  });
  const tilemap = modules["blot:host/Render"]?.orthogonal_tilemap;
  if (tilemap === undefined) {
    throw new Error("test modules omitted Render.orthogonal_tilemap");
  }

  assertThrows(
    () => Reflect.apply(tilemap, undefined, [144]),
    Error,
    'Blot host import "Render.orthogonal_tilemap" runtime reference 144 is unknown or stale',
  );
});

Deno.test("Blot host codecs use guest memory only without a runtime product resolver", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const values = Array.from({ length: 11 }, (_, index) => BigInt(index + 1));
  const view = new DataView(memory.buffer);
  for (const [index, value] of values.entries()) {
    view.setBigInt64(144 + index * 8, value, true);
  }
  let received: unknown;
  const implementations = registered_host_implementations();
  const render = implementations.Render;
  if (render === undefined) throw new Error("test registry omitted Render");
  render.orthogonal_tilemap = (parameter: unknown) => {
    received = parameter;
  };
  const modules = create_test_host_modules(implementations, {
    memory: () => memory,
  });
  const tilemap = modules["blot:host/Render"]?.orthogonal_tilemap;
  if (tilemap === undefined) {
    throw new Error("test modules omitted Render.orthogonal_tilemap");
  }

  Reflect.apply(tilemap, undefined, [144]);

  assertEquals(received, {
    atlas_columns: 1n,
    cell_offset: 2n,
    columns: 3n,
    first_object_id: 4n,
    mesh: 5n,
    origin_x: 6n,
    origin_y: 7n,
    rows: 8n,
    texture: 9n,
    tile_size: 10n,
    z: 11n,
  });
});

Deno.test("Blot host codecs reject boolean representations other than zero or one", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const implementations = registered_host_implementations();
  const modules = create_test_host_modules(implementations, {
    memory: () => memory,
  });
  const status = modules["blot:host/Ui"]?.status;
  if (status === undefined) throw new Error("test modules omitted Ui.status");

  assertThrows(
    () => Reflect.apply(status, undefined, [2, 0, 0, 0, 0]),
    Error,
    "Blot Ui.status parameter.done boolean 2 must be 0 or 1",
  );
  assertThrows(
    () => Reflect.apply(status, undefined, [-1, 0, 0, 0, 0]),
    Error,
    "Blot Ui.status parameter.done boolean -1 must be 0 or 1",
  );
});

Deno.test("Blot host codecs encode indirect result fields in registry order", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const implementations = registered_host_implementations();
  const events = implementations.Events;
  if (events === undefined) throw new Error("test registry omitted Events");
  events.next = () => ({ kind: 11n, target: 12n, value: 13n });
  const modules = create_test_host_modules(
    implementations,
    { memory: () => memory },
  );
  const next = modules["blot:host/Events"]?.next;
  if (next === undefined) {
    throw new Error("test modules omitted Events.next");
  }

  Reflect.apply(next, undefined, [260]);

  const view = new DataView(memory.buffer);
  assertEquals([
    view.getBigInt64(260, true),
    view.getBigInt64(268, true),
    view.getBigInt64(276, true),
  ], [11n, 12n, 13n]);
});

Deno.test("Blot manifests reject a different ABI policy", () => {
  const source = registered_manifest_source().replace('"major":2', '"major":3');

  assertThrows(
    () => parse_blot_manifest(source),
    Error,
    "game manifest ABI.major 3 must be 2",
  );
});

Deno.test("Blot manifests reject a different required export", () => {
  const source = registered_manifest_source().replace(
    '"name":"blot:default"',
    '"name":"blot:other"',
  );

  assertThrows(
    () => parse_blot_manifest(source),
    Error,
    'game manifest export "default" declaration',
  );
});

Deno.test("Blot manifests reject a different host import signature", () => {
  const source = registered_manifest_source().replace(
    '"result":{"kind":"signed-integer-64"}',
    '"result":{"kind":"float-64"}',
  );

  assertThrows(
    () => parse_blot_manifest(source),
    Error,
    'game manifest import "Cells.get" declaration',
  );
});

function registered_manifest_source(): string {
  const runtime_export = blot_abi_registry.runtime_exports[0];
  const host_import = blot_abi_registry.host_imports[0];
  return JSON.stringify({
    format: "blot-core-wasm",
    abi: {
      ...blot_abi_registry.policy,
      requiredFeatures: [],
      optimizationFeatures: [],
    },
    source: "registry-test.blot",
    exports: [{ ...runtime_export, effects: [host_import.capability] }],
    imports: [{
      capability: host_import.capability,
      operation: host_import.operation,
      module: host_import.module,
      name: host_import.name,
      function: host_import.function,
      ownership: host_import.ownership,
    }],
  });
}

function registered_host_implementations(): Record<
  string,
  Record<string, CallableFunction>
> {
  const implementations: Record<
    string,
    Record<string, CallableFunction>
  > = {};
  for (const declaration of blot_abi_registry.host_imports) {
    const operations = implementations[declaration.capability] ?? {};
    operations[declaration.operation] = () => {};
    implementations[declaration.capability] = operations;
  }
  return implementations;
}

function create_test_host_modules(
  implementations: Record<string, Record<string, CallableFunction>>,
  boundary: {
    readonly memory: () => WebAssembly.Memory;
    readonly resolve_runtime_reference?: (reference: number) => unknown;
  },
): Record<string, Record<string, CallableFunction>> {
  return Reflect.apply(create_blot_host_import_modules, undefined, [
    implementations,
    boundary,
  ]) as Record<string, Record<string, CallableFunction>>;
}
