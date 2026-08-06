import { assertEquals } from "@std/assert";
import {
  artifact_revision,
  asset_id,
  content_digest,
  source_revision,
} from "./identity.ts";
import { load_artifact } from "./load.ts";
import type { AssetManifestEntry } from "./manifest.ts";

const hello = new TextEncoder().encode("hello");
const hello_digest = content_digest(
  "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
);

Deno.test("artifact loading verifies byte size and digest before returning bytes", async () => {
  const result = await load_artifact(fixture_entry(), {
    read() {
      return Promise.resolve(hello);
    },
  });

  assertEquals(result, {
    type: "ready",
    id: asset_id("fixture/hello"),
    revision: artifact_revision("artifact-1"),
    bytes: hello,
  });
});

Deno.test("artifact loading reports digest mismatches with revision evidence", async () => {
  const result = await load_artifact(fixture_entry(), {
    read() {
      return Promise.resolve(new TextEncoder().encode("world"));
    },
  });

  if (result.type !== "failed") {
    throw new Error(`expected failed load, received ${result.type}`);
  }
  assertEquals(result.id, "fixture/hello");
  assertEquals(result.revision, "artifact-1");
  assertEquals(
    result.reason,
    "artifact digest sha256:486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7 does not match manifest digest sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
});

Deno.test("artifact loading rejects partial reads before digest verification", async () => {
  const result = await load_artifact(fixture_entry(), {
    read() {
      return Promise.resolve(hello.slice(0, 2));
    },
  });
  if (result.type !== "failed") {
    throw new Error(`expected failed, received ${result.type}`);
  }
  assertEquals(
    result.reason,
    "artifact byte size 2 does not match manifest byte size 5",
  );
});

Deno.test("artifact loading does not call the reader after cancellation", async () => {
  const cancellation = new AbortController();
  cancellation.abort();
  let reads = 0;
  const result = await load_artifact(fixture_entry(), {
    read() {
      reads += 1;
      return Promise.resolve(hello);
    },
  }, cancellation.signal);

  assertEquals(result, {
    type: "cancelled",
    id: asset_id("fixture/hello"),
    revision: artifact_revision("artifact-1"),
  });
  assertEquals(reads, 0);
});

function fixture_entry(): AssetManifestEntry {
  return {
    id: asset_id("fixture/hello"),
    kind: "fixture",
    source_revision: source_revision("source-1"),
    artifact_revision: artifact_revision("artifact-1"),
    byte_size: hello.length,
    digest: hello_digest,
    location: "hello.bin",
    dependencies: [],
    variants: {},
  };
}
