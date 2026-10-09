import { assert, assertEquals, assertRejects } from "@std/assert";
import { Heightfield } from "@ink/geometry";
import { assetSlug, newTerrainPlan, waitForAsset } from "./create.ts";

Deno.test("a new terrain file is a flat field on layer 0", () => {
  for (
    const [cells, layers, splat] of [[64, 4, 32], [256, 6, 128], [100, 1, 50]]
  ) {
    const plan = newTerrainPlan({ cells, layers, splatCells: splat });
    const file = new Uint8Array(plan.size);
    for (const s of plan.segments) file.set(s.bytes, s.offset);
    assertEquals(
      file,
      Heightfield.create(cells, { layers, splatCells: splat }).serialize(),
    );
    // Only the header and one splat plane need sending.
    const sent = plan.segments.reduce((n, s) => n + s.bytes.length, 0);
    assert(sent < plan.size / 2 || cells < 128);
  }
  const big = newTerrainPlan({ cells: 2048, layers: 4 });
  assertEquals(
    big.size,
    32 + 257 ** 2 * 4 + 2049 ** 2 * 4 + 1024 ** 2 * 4,
  );
});

Deno.test("names become safe file names", () => {
  assertEquals(assetSlug(" My Big World! "), "My-Big-World-");
  assertEquals(assetSlug("../etc/passwd"), "etc-passwd");
  assertEquals(assetSlug("world.terrain"), "world");
  assertEquals(assetSlug("..."), "");
  assertEquals(assetSlug(""), "");
});

Deno.test("waiting for an asset ends when the catalog lists it", async () => {
  const listeners = new Set<() => void>();
  const catalog = { assets: { mesh: [], texture: [], sound: [] } } as {
    assets: Record<string, string[]>;
  };
  const session = {
    catalog,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  const waiting = waitForAsset(
    session as never,
    "terrain",
    "terrain/a.terrain",
    500,
  );
  catalog.assets.terrain = ["terrain/a.terrain"];
  for (const l of listeners) l();
  await waiting;
  assertEquals(listeners.size, 0);
  await assertRejects(
    () => waitForAsset(session as never, "scatter", "scatter/x.scatter", 10),
    Error,
    "did not show up",
  );
  assertEquals(listeners.size, 0);
});
