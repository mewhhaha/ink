import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { parseGltf } from "../render/gltf.ts";
import { AssetImporter } from "./mod.ts";
import { LOD_EXTENSION } from "./format.ts";
import { decodeImage, fitSize, mipChain } from "./image.ts";
import { inspectKtx2, writeRawKtx2 } from "./ktx2.ts";
import { encodeTexture, previewTexture } from "./texture.ts";

const root = new URL("../../", import.meta.url).pathname;

Deno.test("fitSize respects limits and block multiples", () => {
  assertEquals(fitSize(4096, 4096, 2048, Infinity, 4), [2048, 2048]);
  assertEquals(fitSize(1001, 333, 4096, Infinity, 4), [1000, 332]);
  const [w, h] = fitSize(4096, 4096, 4096, 12_000_000, 4);
  assert(w * h <= 12_000_000 && w % 4 === 0);
});

Deno.test("preview textures carry a complete mip chain", async () => {
  const png = await Deno.readFile(
    join(root, "examples/hammer/assets/textures/brick.png"),
  );
  const image = decodeImage(png);
  assertEquals(mipChain(image, true).length, 8);
  const preview = previewTexture(png, "color", 64);
  const info = inspectKtx2(preview.ktx2);
  assertEquals([info.width, info.levels, info.vkFormat], [64, 7, 43]);
  const raw = inspectKtx2(writeRawKtx2(mipChain(image, false), false));
  assertEquals(raw.vkFormat, 37);
});

Deno.test("basis encoding produces compressed KTX2", async () => {
  const png = await Deno.readFile(
    join(root, "examples/hammer/assets/textures/brick.png"),
  );
  const out = await encodeTexture(png, "normal", {
    mode: "balanced",
    maxSize: 4096,
    previewSize: 64,
  });
  assertEquals(out.codec, "uastc");
  assertEquals(inspectKtx2(out.ktx2).vkFormat, 0);
});

Deno.test("importer compresses a skinned model and reuses the cache", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "assets/models"), { recursive: true });
    await Deno.copyFile(
      join(root, "examples/feel/assets/models/runner.glb"),
      join(dir, "assets/models/runner.glb"),
    );
    const make = () =>
      new AssetImporter({
        assetsDir: join(dir, "assets"),
        cacheDir: join(dir, ".ink/cache"),
        settings: { minBytes: 0 },
        workers: 2,
      });
    const first = make();
    try {
      await first.scan();
      await first.idle();
      const status = first.status("models/runner.glb")!;
      assertEquals(status.state, "ready");
      const output = first.output("models/runner.glb")!;
      assert(output.bytes < status.sourceBytes / 2);
      const bytes = await Deno.readFile(output.file);
      const model = await parseGltf(
        bytes.buffer as ArrayBuffer,
        "file:///x/runner.glb",
      );
      assertEquals(model.clips.length, 3);
      assert(model.skins.length > 0);
      // Skinned primitives never get simplified levels.
      assert(model.meshes.flat().every((p) => !p.mesh.lods));
    } finally {
      first.dispose();
    }
    const second = make();
    try {
      await second.scan();
      await second.idle();
      assertEquals(second.status("models/runner.glb")!.state, "ready");
    } finally {
      second.dispose();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("static meshes get simplified levels that share the vertices", async () => {
  const { importGltf } = await import("./gltf.ts");
  const { WorkerPool } = await import("./pool.ts");
  const { writeGlb } = await import("./gltf.ts");
  const { DEFAULT_SETTINGS } = await import("./format.ts");
  // A 100 x 100 grid: 20,000 triangles.
  const n = 100, verts = (n + 1) * (n + 1);
  const positions = new Float32Array(verts * 3);
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      positions.set(
        [i, Math.sin(i / 9) * Math.cos(j / 7) * 2, j],
        (j * (n + 1) + i) * 3,
      );
    }
  }
  const indices = new Uint32Array(n * n * 6);
  let k = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      indices.set([a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2], k);
      k += 6;
    }
  }
  const bin = new Uint8Array(positions.byteLength + indices.byteLength);
  bin.set(new Uint8Array(positions.buffer), 0);
  bin.set(new Uint8Array(indices.buffer), positions.byteLength);
  const glb = writeGlb({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: verts, type: "VEC3" },
      {
        bufferView: 1,
        componentType: 5125,
        count: indices.length,
        type: "SCALAR",
      },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      {
        buffer: 0,
        byteOffset: positions.byteLength,
        byteLength: indices.byteLength,
      },
    ],
    buffers: [{ byteLength: bin.length }],
  }, bin);
  const pool = new WorkerPool(2);
  try {
    const out = await importGltf(
      glb,
      () => Promise.reject(new Error("no files")),
      "full",
      DEFAULT_SETTINGS,
      pool,
    );
    const model = await parseGltf(
      out.glb.buffer as ArrayBuffer,
      "file:///x/grid.glb",
    );
    const mesh = model.meshes[0][0].mesh;
    assertEquals(mesh.indices.length, indices.length);
    assert(mesh.lods && mesh.lods.length >= 2);
    for (const level of mesh.lods) {
      assert(level.indices.length < mesh.indices.length);
      assert(level.error > 0);
      assert(level.indices.every((i) => i < mesh.positions.length / 3));
    }
    assert(
      JSON.stringify(new TextDecoder().decode(out.glb.subarray(20, 4000)))
        .includes(LOD_EXTENSION),
    );
  } finally {
    pool.terminate();
  }
});
