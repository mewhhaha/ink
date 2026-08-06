import { assertEquals, assertThrows } from "@std/assert";
import { RenderGraph } from "./graph.ts";

const buffer = { type: "buffer" as const, size_bytes: 256, usage: 0x80 };

Deno.test("render graph rejects read before write", () => {
  const graph = new RenderGraph()
    .resource({ id: "value", descriptor: buffer, lifetime: "transient" })
    .pass({
      id: "read",
      kind: "compute",
      reads: [{ resource: "value", access: "storage_read" }],
      writes: [],
      after: [],
    })
    .pass({
      id: "write",
      kind: "compute",
      reads: [],
      writes: [{
        resource: "value",
        access: "storage_write",
        load: "discard",
        store: "store",
      }],
      after: [],
    });
  assertThrows(
    () => graph.compile(),
    Error,
    'reads resource "value" before it is written',
  );
});

Deno.test("render graph reports explicit dependency cycles", () => {
  const graph = new RenderGraph()
    .resource({
      id: "external",
      descriptor: buffer,
      lifetime: "external",
      initial_content: "present",
    })
    .pass({
      id: "left",
      kind: "compute",
      reads: [{ resource: "external", access: "storage_read" }],
      writes: [],
      after: ["right"],
    })
    .pass({
      id: "right",
      kind: "compute",
      reads: [],
      writes: [],
      after: ["left"],
    });
  assertThrows(() => graph.compile(), Error, "left -> right -> left");
});

Deno.test("render graph aliases matching non-overlapping transients", () => {
  const graph = new RenderGraph()
    .resource({ id: "first", descriptor: buffer, lifetime: "transient" })
    .resource({ id: "second", descriptor: buffer, lifetime: "transient" })
    .pass({
      id: "a_write",
      kind: "compute",
      reads: [],
      writes: [{
        resource: "first",
        access: "storage_write",
        load: "discard",
        store: "store",
      }],
      after: [],
    })
    .pass({
      id: "b_read",
      kind: "compute",
      reads: [{ resource: "first", access: "storage_read" }],
      writes: [],
      after: ["a_write"],
    })
    .pass({
      id: "c_write",
      kind: "compute",
      reads: [],
      writes: [{
        resource: "second",
        access: "storage_write",
        load: "discard",
        store: "store",
      }],
      after: ["b_read"],
    })
    .pass({
      id: "d_read",
      kind: "compute",
      reads: [{ resource: "second", access: "storage_read" }],
      writes: [],
      after: ["c_write"],
    });
  const compiled = graph.compile();
  assertEquals(compiled.transient_slot_count, 1);
  assertEquals(compiled.lifetimes.map((lifetime) => lifetime.alias_slot), [
    0,
    0,
  ]);
});

Deno.test("render graph rejects incompatible texture access", () => {
  const graph = new RenderGraph()
    .resource({
      id: "color",
      lifetime: "external",
      initial_content: "present",
      descriptor: {
        type: "texture",
        width: 1,
        height: 1,
        depth_or_layers: 1,
        mip_levels: 1,
        sample_count: 1,
        format: "rgba8unorm",
        usage: 1,
      },
    })
    .pass({
      id: "bad",
      kind: "render",
      reads: [{ resource: "color", access: "vertex" }],
      writes: [],
      after: [],
    });
  assertThrows(
    () => graph.compile(),
    Error,
    'uses texture resource "color" as vertex',
  );
});
