import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { Heightfield, ScatterSet } from "@ink/geometry";
import { ScatterResource, TerrainResource } from "@ink/render";
import { AssetWrites } from "@ink/dev/asset-write";
import { encodeSegments } from "@ink/dev/segments";
import {
  type AssetSink,
  ScatterSaver,
  type Segment,
  TerrainSaver,
  terrainSegments,
} from "./save.ts";
import {
  type Dab,
  DabPath,
  footprint,
  type Ground,
  noiseRelief,
  paintLayer,
  raise,
  smooth,
} from "./sculpt.ts";
import { StrokeRecorder } from "./stroke.ts";
import { planAdd, scatterCandidates } from "./scatter_brush.ts";
import { ScatterStroke } from "./scatter_stroke.ts";

function apply(file: Uint8Array, segments: Segment[]): Uint8Array {
  const out = file.slice();
  for (const s of segments) out.set(s.bytes, s.offset);
  return out;
}

function edited(cells: number, splatCells: number, layers: number) {
  const field = Heightfield.create(cells, { splatCells, layers });
  for (let i = 0; i < field.heights.length; i++) {
    field.heights[i] = Math.sin(i * 0.013) * 4;
  }
  return field;
}

Deno.test("segments bring an old file up to date, byte for byte", () => {
  for (
    const [cells, splat, layers] of [[64, 32, 6], [512, 256, 4], [300, 100, 8]]
  ) {
    const field = edited(cells, splat, layers);
    const old = field.serialize();
    const ground: Ground = { field, size: cells };
    const dab: Dab = {
      x: 3,
      z: -5,
      radius: cells / 6,
      falloff: { shape: "smooth", hardness: 0.3 },
    };
    const a = raise(ground, dab, 2).rect!;
    const b = paintLayer(ground, dab, layers - 1, 0.8).splatRect!;
    field.revision = 9;
    const segments = terrainSegments(
      field,
      { rect: a, splatRect: b },
      field.revision,
    );
    assertEquals(apply(old, segments), field.serialize(), `${cells} cells`);
    // The patch is a small part of the file.
    const sent = segments.reduce((n, s) => n + s.bytes.length, 0);
    assert(sent < old.length / 2, `${sent} of ${old.length}`);
  }
});

Deno.test("whole rows and the field's borders are written correctly", () => {
  const field = edited(128, 64, 5);
  const old = field.serialize();
  const ground: Ground = { field, size: 128 };
  // A wide, hard dab over a corner and a full-width band of raised ground.
  const rect = raise(ground, {
    x: -64,
    z: -64,
    radius: 40,
    falloff: { shape: "constant", hardness: 0 },
  }, 1).rect!;
  for (let z = 100; z < 110; z++) {
    for (let x = 0; x < field.stride; x++) {
      field.heights[z * field.stride + x] += 3;
    }
  }
  field.revision = 2;
  const segments = terrainSegments(field, {
    rect: { x0: 0, z0: 0, x1: field.stride, z1: field.stride },
    splatRect: null,
  }, 2);
  assertEquals(apply(old, segments), field.serialize());
  const corner = terrainSegments(field, { rect, splatRect: null }, 2);
  assert(corner.length > 10);
  // Nothing dirty still carries the revision.
  const none = terrainSegments(field, { rect: null, splatRect: null }, 5);
  assertEquals(none.length, 1);
  assertEquals(none[0].offset, 20);
  assertEquals([...none[0].bytes], [5, 0, 0, 0]);
});

Deno.test("savers collect a flurry of changes into one request", async () => {
  const field = edited(256, 128, 4);
  const resource = TerrainResource.ready("a.terrain", field);
  const calls: Segment[][] = [];
  const sink: AssetSink = {
    patchAsset: (_p, segments) => {
      calls.push([...segments]);
      return Promise.resolve();
    },
    putAsset: () => Promise.resolve(),
  };
  const saver = new TerrainSaver(resource, sink, { delay: 20 });
  const ground: Ground = { field, size: 256 };
  for (let i = 0; i < 4; i++) {
    const recorder = new StrokeRecorder(resource);
    const dab: Dab = {
      x: i * 40 - 60,
      z: 0,
      radius: 20,
      falloff: { shape: "smooth", hardness: 0 },
    };
    const fp = footprint(ground, dab);
    recorder.prepare(fp);
    raise(ground, dab, 1);
    resource.markDirty(fp.rect!);
    recorder.finish();
  }
  assertEquals(calls.length, 0, "nothing is sent while changes keep coming");
  assert(saver.dirty);
  await new Promise((r) => setTimeout(r, 80));
  assertEquals(calls.length, 1);
  assert(!saver.dirty);
  // The revision comes last in the request.
  const last = calls[0].at(-1)!;
  assertEquals(last.offset, 20);
  assertEquals(
    new DataView(last.bytes.buffer, last.bytes.byteOffset).getUint32(0, true),
    resource.revision,
  );
  // Undo is a change too; reloading from disk is not.
  resource.seek(0);
  await saver.flush();
  assertEquals(calls.length, 2);
  resource.setField(Heightfield.parse(field.serialize()));
  await saver.flush();
  assertEquals(calls.length, 2);
  await saver.dispose();
});

Deno.test("a failed write is kept for the next one", async () => {
  const field = edited(64, 32, 4);
  const resource = TerrainResource.ready("a.terrain", field);
  let fail = true;
  const sent: Segment[][] = [];
  const errors: unknown[] = [];
  const saver = new TerrainSaver(resource, {
    patchAsset: (_p, segments) => {
      if (fail) return Promise.reject(new Error("offline"));
      sent.push([...segments]);
      return Promise.resolve();
    },
    putAsset: () => Promise.resolve(),
  }, { delay: 1, onError: (e) => errors.push(e) });
  const ground: Ground = { field, size: 64 };
  const recorder = new StrokeRecorder(resource);
  const dab: Dab = {
    x: 0,
    z: 0,
    radius: 10,
    falloff: { shape: "smooth", hardness: 0 },
  };
  recorder.prepare(footprint(ground, dab));
  raise(ground, dab, 1);
  recorder.finish();
  await saver.flush();
  assertEquals(errors.length, 1);
  assert(saver.dirty);
  fail = false;
  await saver.flush();
  assertEquals(sent.length, 1);
  assert(!saver.dirty);
  await saver.dispose();
});

Deno.test("scatter savers send the sorted file and the revision", async () => {
  const set = new ScatterSet();
  const resource = ScatterResource.ready("t.scatter", set);
  const files: Uint8Array[] = [];
  const saver = new ScatterSaver(resource, {
    patchAsset: () => Promise.resolve(),
    putAsset: (_p, bytes) => {
      files.push(bytes);
      return Promise.resolve();
    },
  }, { delay: 1 });
  const stroke = new ScatterStroke(resource);
  const brush = {
    seed: 3,
    density: 0.1,
    minSpacing: 2,
    scale: [1, 1] as [number, number],
    tint: [0, 1] as [number, number],
  };
  const flat = { shape: "constant", hardness: 0 } as const;
  stroke.add(planAdd(set, scatterCandidates(brush, 0, 0, 60, flat), 2));
  assertEquals(files.length, 0);
  stroke.finish();
  await saver.flush();
  assertEquals(files.length, 1);
  const copy = ScatterSet.parse(files[0]);
  assertEquals(copy.count, set.count);
  assertEquals(copy.revision, 1);
  await saver.dispose();
});

/** The server's own writer behind the client interface, on a temp project. */
function localSink(writes: AssetWrites): AssetSink & {
  requests: number;
} {
  const sink = {
    requests: 0,
    async patchAsset(path: string, segments: readonly Segment[]) {
      sink.requests++;
      await writes.handle(
        "PATCH",
        path,
        new URLSearchParams(),
        encodeSegments(segments),
      );
    },
    async putAsset(path: string, bytes: Uint8Array) {
      sink.requests++;
      await writes.handle("PUT", path, new URLSearchParams(), bytes);
    },
  };
  return sink;
}

Deno.test("strokes, undo and redo keep the file on disk identical to the data", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const assets = join(dir, "assets");
    await Deno.mkdir(assets);
    const writes = new AssetWrites(assets);
    const field = Heightfield.create(512, { splatCells: 256, layers: 6 });
    const initial = field.serialize();
    await writes.handle(
      "PUT",
      "terrain/world.terrain",
      new URLSearchParams("create=1"),
      initial,
    );
    const file = join(assets, "terrain/world.terrain");
    const resource = TerrainResource.ready("terrain/world.terrain", field);
    const sink = localSink(writes);
    const saver = new TerrainSaver(resource, sink, { delay: 1 });
    const ground: Ground = { field, size: 512 };

    const stroke = (
      points: [number, number][],
      radius: number,
      op: (g: Ground, d: Dab) => void,
      paints = false,
    ) => {
      const recorder = new StrokeRecorder(resource);
      const path = new DabPath(radius * 0.3);
      const falloff = { shape: "smooth", hardness: 0.2 } as const;
      const dab = ([x, z]: [number, number]): Dab => ({
        x,
        z,
        radius,
        falloff,
      });
      const at = (p: [number, number]) => {
        const fp = footprint(ground, dab(p), paints);
        recorder.prepare(fp);
        op(ground, dab(p));
        resource.markDirty(
          fp.rect ?? { x0: 0, z0: 0, x1: 1, z1: 1 },
          fp.splatRect ?? undefined,
        );
      };
      path.start(...points[0]).forEach(at);
      for (const p of points.slice(1)) path.move(...p).forEach(at);
      return recorder.finish()!;
    };

    const onDisk = async () => await Deno.readFile(file);
    const same = async (message: string) => {
      await saver.flush();
      assertEquals(await onDisk(), field.serialize(), message);
    };

    stroke([[-200, -100], [200, 80]], 28, (g, d) => raise(g, d, 1.2));
    await same("after a raise");
    stroke([[-100, 0], [100, 0]], 24, (g, d) => smooth(g, d, 0.5, 3));
    stroke(
      [[0, -150], [60, 150]],
      30,
      (g, d) => paintLayer(g, d, 5, 0.7),
      true,
    );
    stroke(
      [[-30, 20], [120, 60]],
      18,
      (g, d) =>
        noiseRelief(g, d, { seed: 4, scale: 15, octaves: 3, metres: 0.5 }),
    );
    await same("after four strokes");
    assert(sink.requests <= 4, `${sink.requests} requests`);

    const end = resource.revision;
    resource.seek(0);
    await same("after undoing everything");
    assertEquals(
      Heightfield.parse(await onDisk()).heights,
      new Float32Array(513 * 513),
    );
    assert(resource.seek(end));
    await same("after redoing to the end");
    assertEquals(Heightfield.parse(await onDisk()).revision, end);
    await saver.dispose();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
