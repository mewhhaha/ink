import { assertEquals, assertThrows } from "@std/assert";
import {
  artifact_revision,
  asset_id,
  content_digest,
  source_revision,
} from "../identity.ts";
import type { ArtifactLoadResult } from "../load.ts";
import type { AssetManifestEntry } from "../manifest.ts";
import { AssetLoadQueue } from "./stream.ts";

const hello = new TextEncoder().encode("hello");
const hello_digest = content_digest(
  "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
);

Deno.test("asset load queues start waiting work by priority and then request order", async () => {
  const reads: string[] = [];
  const pending: (() => void)[] = [];
  const queue = new AssetLoadQueue({
    read(location) {
      reads.push(location);
      return new Promise((resolve) => pending.push(() => resolve(hello)));
    },
  }, 1);

  const first = queue.request(entry("first"), "background");
  const second = queue.request(entry("second"), "background");
  const blocking = queue.request(entry("blocking"), "blocking");
  assertEquals(reads, ["first.bin"]);
  pending.shift()!();
  await first;
  assertEquals(reads, ["first.bin", "blocking.bin"]);
  pending.shift()!();
  await blocking;
  assertEquals(reads, ["first.bin", "blocking.bin", "second.bin"]);
  pending.shift()!();
  await second;
});

Deno.test("asset load queues share one read between subscribers", async () => {
  let reads = 0;
  const queue = new AssetLoadQueue({
    read() {
      reads += 1;
      return Promise.resolve(hello);
    },
  }, 2);
  const asset = entry("shared");
  const [first, second] = await Promise.all([
    queue.request(asset, "visible"),
    queue.request(asset, "blocking"),
  ]);
  assert_ready(first);
  assert_ready(second);
  assertEquals(reads, 1);
  first.bytes[0] = 0;
  assertEquals(second.bytes, hello);
});

Deno.test("asset load queues reject invalid priorities and conflicting revisions", async () => {
  let finish: ((bytes: Uint8Array) => void) | undefined;
  const queue = new AssetLoadQueue({
    read() {
      return new Promise((resolve) => finish = resolve);
    },
  }, 1);
  const asset = entry("shared");
  const pending = queue.request(asset, "visible");
  assertThrows(
    () => queue.request(asset, "urgent" as never),
    Error,
    'asset load priority "urgent" is invalid',
  );
  assertThrows(
    () => queue.request({ ...asset, location: "other.bin" }, "visible"),
    Error,
    'asset load "shared" revision "artifact-1" conflicts',
  );
  finish!(hello);
  assertEquals((await pending).type, "ready");
});

Deno.test("cancelling a waiting request prevents its platform read", async () => {
  const reads: string[] = [];
  let release_first: (() => void) | undefined;
  const queue = new AssetLoadQueue({
    read(location) {
      reads.push(location);
      if (location === "first.bin") {
        return new Promise((resolve) => {
          release_first = () => resolve(hello);
        });
      }
      return Promise.resolve(hello);
    },
  }, 1);
  const first = queue.request(entry("first"), "visible");
  const cancellation = new AbortController();
  const cancelled = queue.request(
    entry("cancelled"),
    "visible",
    cancellation.signal,
  );
  cancellation.abort();
  assertEquals((await cancelled).type, "cancelled");
  release_first!();
  await first;
  assertEquals(reads, ["first.bin"]);
});

function entry(id: string): AssetManifestEntry {
  return {
    id: asset_id(id),
    kind: "fixture",
    source_revision: source_revision("source-1"),
    artifact_revision: artifact_revision("artifact-1"),
    byte_size: hello.length,
    digest: hello_digest,
    location: `${id}.bin`,
    dependencies: [],
    variants: {},
  };
}

function assert_ready(
  result: ArtifactLoadResult,
): asserts result is Extract<ArtifactLoadResult, { type: "ready" }> {
  if (result.type !== "ready") {
    throw new Error(`expected ready, received ${result.type}`);
  }
}
