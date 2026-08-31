import { assertEquals, assertThrows } from "@std/assert";
import { AssetCache } from "./cache.ts";
import { artifact_revision, asset_id } from "./identity.ts";

Deno.test("cache eviction removes the least recently used unleased asset", () => {
  const cache = new AssetCache(4);
  const first = ready("first", [1, 2]);
  const second = ready("second", [3, 4]);
  const third = ready("third", [5, 6]);
  assertEquals(cache.publish(first).type, "published");
  assertEquals(cache.publish(second).type, "published");

  const second_lease = cache.acquire(second.id)!;
  second_lease.release();
  assertEquals(cache.publish(third), {
    type: "published",
    id: third.id,
    evicted: [first.id],
  });
  assertEquals(cache.state(first.id), {
    type: "evicted",
    id: first.id,
    revision: first.revision,
  });
  assertEquals(cache.resident_bytes, 4);
});

Deno.test("cache budgets never evict assets protected by leases", () => {
  const cache = new AssetCache(2);
  const first = ready("first", [1, 2]);
  cache.publish(first);
  const lease = cache.acquire(first.id)!;

  assertEquals(cache.publish(ready("second", [3])), {
    type: "rejected",
    id: asset_id("second"),
    reason:
      'asset "second" needs 1 bytes but 2 of 2 bytes are pinned by leases',
  });
  assertEquals(lease.read(), new Uint8Array([1, 2]));
  lease.release();
});

Deno.test("rejected cache publications do not evict the current unleased assets", () => {
  const cache = new AssetCache(4);
  const pinned = ready("pinned", [1, 2, 3]);
  const retained = ready("retained", [4]);
  cache.publish(pinned);
  cache.publish(retained);
  const lease = cache.acquire(pinned.id)!;

  assertEquals(cache.publish(ready("too-large", [5, 6])).type, "rejected");
  assertEquals(cache.state(retained.id), {
    type: "ready",
    id: retained.id,
    revision: retained.revision,
    byte_size: 1,
    lease_count: 0,
  });
  assertEquals(cache.resident_bytes, 4);
  lease.release();
});

Deno.test("asset leases reject reads and duplicate releases after release", () => {
  const cache = new AssetCache(1);
  const result = ready("fixture", [1]);
  cache.publish(result);
  const lease = cache.acquire(result.id)!;
  lease.release();

  assertThrows(
    () => lease.read(),
    Error,
    'asset lease "fixture" was read after release',
  );
  assertThrows(
    () => lease.release(),
    Error,
    'asset lease "fixture" was released more than once',
  );
});

Deno.test("atomic replacement keeps leased revisions usable until release", () => {
  const cache = new AssetCache(4);
  const original = ready("mesh", [1, 2]);
  cache.publish(original);
  const old_lease = cache.acquire(original.id)!;
  const replacement = ready_revision("mesh", "revision-2", [3, 4]);

  assertEquals(cache.replace([{ artifact: replacement, dependencies: [] }]), {
    type: "replaced",
    ids: [replacement.id],
    evicted: [],
  });
  assertEquals(old_lease.read(), new Uint8Array([1, 2]));
  assertEquals(cache.acquire(original.id)!.read(), new Uint8Array([3, 4]));
  assertEquals(cache.resident_bytes, 4);
  old_lease.release();
  assertEquals(cache.resident_bytes, 2);
});

Deno.test("replacement dependency failures leave the current revision unchanged", () => {
  const cache = new AssetCache(4);
  const original = ready("mesh", [1, 2]);
  cache.publish(original);
  const replacement = ready_revision("mesh", "revision-2", [3, 4]);

  assertEquals(
    cache.replace([{
      artifact: replacement,
      dependencies: [asset_id("missing-texture")],
    }]),
    {
      type: "rejected",
      reason:
        'replacement asset "mesh" depends on unavailable asset "missing-texture"',
    },
  );
  assertEquals(cache.state(original.id), {
    type: "ready",
    id: original.id,
    revision: original.revision,
    byte_size: 2,
    lease_count: 0,
  });
});

Deno.test("replacement eviction retains its complete dependency closure", () => {
  const cache = new AssetCache(6);
  const texture = ready("texture", [1, 2]);
  const material = ready("material", [3, 4]);
  const unrelated = ready("unrelated", [5, 6]);
  cache.publish(texture);
  assertEquals(
    cache.replace([{
      artifact: material,
      dependencies: [texture.id],
    }]).type,
    "replaced",
  );
  cache.publish(unrelated);
  const scene = ready("scene", [7, 8]);

  assertEquals(
    cache.replace([{
      artifact: scene,
      dependencies: [material.id],
    }]),
    {
      type: "replaced",
      ids: [scene.id],
      evicted: [unrelated.id],
    },
  );
  assertEquals(cache.state(texture.id).type, "ready");
  assertEquals(cache.state(material.id).type, "ready");
  assertEquals(cache.state(unrelated.id).type, "evicted");
});

Deno.test("failed replacement records evidence without discarding the ready revision", () => {
  const cache = new AssetCache(2);
  const original = ready("mesh", [1, 2]);
  cache.publish(original);
  cache.record_failure({
    type: "failed",
    id: original.id,
    revision: artifact_revision("revision-2"),
    location: "mesh.bin",
    reason: "network disconnected",
  });

  assertEquals(cache.state(original.id), {
    type: "ready",
    id: original.id,
    revision: original.revision,
    byte_size: 2,
    lease_count: 0,
  });
  const lease = cache.acquire(original.id)!;
  assertEquals(lease.read(), new Uint8Array([1, 2]));
  lease.release();
});

function ready(id: string, bytes: readonly number[]) {
  return ready_revision(id, `revision-${id}`, bytes);
}

function ready_revision(
  id: string,
  revision: string,
  bytes: readonly number[],
) {
  return {
    type: "ready" as const,
    id: asset_id(id),
    revision: artifact_revision(revision),
    bytes: new Uint8Array(bytes),
  };
}
