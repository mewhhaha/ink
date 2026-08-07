import { assertEquals, assertThrows } from "@std/assert";
import { render_frame_id, render_resource_id } from "./model.ts";
import {
  fallback_resource_id,
  RenderResourcePool,
  staging_upload,
} from "./resources.ts";

Deno.test("resource pool retains replaced allocations until their fence frame", () => {
  const pool = new RenderResourcePool({
    maximum_bytes: 1_024,
    maximum_resources: 4,
    deferred_frame_count: 2,
  });
  const id = render_resource_id("vertices");
  pool.create(
    id,
    { type: "buffer", size_bytes: 128, usage: 1 },
    render_frame_id(0),
  );
  pool.replace(
    id,
    { type: "buffer", size_bytes: 256, usage: 1 },
    render_frame_id(1),
  );
  assertEquals(pool.snapshot().retained_bytes, 384);
  assertEquals(pool.collect(render_frame_id(2)), []);
  assertEquals(
    pool.collect(render_frame_id(3)).map((resource) => resource.revision),
    [0],
  );
  assertEquals(pool.snapshot().retained_bytes, 256);
});

Deno.test("resource pool reports allocation evidence at its byte budget", () => {
  const pool = new RenderResourcePool({
    maximum_bytes: 64,
    maximum_resources: 1,
    deferred_frame_count: 1,
  });
  assertThrows(
    () =>
      pool.create(render_resource_id("too-large"), {
        type: "buffer",
        size_bytes: 128,
        usage: 1,
      }, render_frame_id(0)),
    Error,
    "needs 128 bytes",
  );
});

Deno.test("staging uploads copy bytes and enforce WebGPU alignment", () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const upload = staging_upload(render_resource_id("buffer"), 4, bytes);
  bytes[0] = 9;
  assertEquals(upload.bytes, new Uint8Array([1, 2, 3, 4]));
  assertThrows(
    () => staging_upload(render_resource_id("buffer"), 2, new Uint8Array(4)),
    Error,
    "4-byte aligned",
  );
});

Deno.test("fallback resources have stable typed identities", () => {
  assertEquals(fallback_resource_id("normal"), "fallback:normal");
});

Deno.test("resource descriptors reject unknown types before entering the pool", () => {
  const pool = new RenderResourcePool({
    maximum_bytes: 64,
    maximum_resources: 1,
    deferred_frame_count: 0,
  });
  assertThrows(
    () =>
      pool.create(render_resource_id("unknown"), {
        type: "acceleration_structure",
      } as never, render_frame_id(0)),
    Error,
    'descriptor type "acceleration_structure" is unsupported',
  );
});
