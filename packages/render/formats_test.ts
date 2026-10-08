import { assert, assertEquals } from "@std/assert";
import { encodePng, parseGltf, parseObj } from "./mod.ts";
import { zlibStored } from "./png.ts";

Deno.test("PNG encoder produces a valid, decodable file", async () => {
  const w = 3, h = 2;
  const rgba = new Uint8Array(w * h * 4).map((_, i) => (i * 37) & 255);
  const png = await encodePng(w, h, rgba);
  assertEquals(Array.from(png.slice(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
  const dv = new DataView(png.buffer);
  assertEquals(dv.getUint32(16), w);
  assertEquals(dv.getUint32(20), h);
  // Pull out the IDAT payload and inflate it.
  let o = 8;
  let idat = new Uint8Array(0);
  while (o < png.length) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(...png.slice(o + 4, o + 8));
    if (type === "IDAT") idat = png.slice(o + 8, o + 8 + len);
    o += 12 + len;
  }
  for (const stream of [idat, zlibStored(new Uint8Array([0, 1, 2, 3]))]) {
    const raw = new Uint8Array(
      await new Response(
        new Blob([stream as BlobPart]).stream().pipeThrough(
          new DecompressionStream("deflate"),
        ),
      ).arrayBuffer(),
    );
    if (stream === idat) {
      assertEquals(raw.length, (w * 4 + 1) * h);
      assertEquals(
        Array.from(raw.slice(1, 1 + w * 4)),
        Array.from(rgba.slice(0, w * 4)),
      );
    } else assertEquals(Array.from(raw), [0, 1, 2, 3]);
  }
  // Deno can decode what we wrote.
  const bitmap = await createImageBitmap(new Blob([png as BlobPart]));
  assertEquals([bitmap.width, bitmap.height], [w, h]);
});

Deno.test("OBJ: polygons are triangulated, normals computed, v flipped", () => {
  const mesh = parseObj(`
    v 0 0 0
    v 1 0 0
    v 1 1 0
    v 0 1 0
    vt 0 0
    vt 1 0
    vt 1 1
    vt 0 1
    f 1/1 2/2 3/3 4/4
  `);
  assertEquals(mesh.indices.length, 6);
  assertEquals(mesh.positions.length / 3, 4);
  assertEquals(Array.from(mesh.normals.slice(0, 3)), [0, 0, 1]);
  assertEquals(Array.from(mesh.uvs.slice(0, 4)), [0, 1, 1, 1]);
  const negative = parseObj("v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1");
  assertEquals(negative.indices.length, 3);
});

function quadGltf(embed: "glb" | "data") {
  const positions = new Float32Array([
    -0.5,
    -0.5,
    0,
    0.5,
    -0.5,
    0,
    0.5,
    0.5,
    0,
    -0.5,
    0.5,
    0,
  ]);
  const uvs = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const bin = new Uint8Array(48 + 32 + 12);
  bin.set(new Uint8Array(positions.buffer), 0);
  bin.set(new Uint8Array(uvs.buffer), 48);
  bin.set(new Uint8Array(indices.buffer), 80);
  let text = "";
  for (const b of bin) text += String.fromCharCode(b);
  const json = {
    asset: { version: "2.0" },
    buffers: [
      embed === "data"
        ? {
          byteLength: bin.length,
          uri: `data:application/octet-stream;base64,${btoa(text)}`,
        }
        : { byteLength: bin.length },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 48 },
      { buffer: 0, byteOffset: 48, byteLength: 32 },
      { buffer: 0, byteOffset: 80, byteLength: 12 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: "VEC3" },
      { bufferView: 1, componentType: 5126, count: 4, type: "VEC2" },
      { bufferView: 2, componentType: 5123, count: 6, type: "SCALAR" },
    ],
    meshes: [{
      primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2 }],
    }],
  };
  const jsonText = JSON.stringify(json);
  if (embed === "data") return new TextEncoder().encode(jsonText);
  const jsonBytes = new TextEncoder().encode(
    jsonText + " ".repeat((4 - (jsonText.length % 4)) % 4),
  );
  const total = 12 + 8 + jsonBytes.length + 8 + bin.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  const o = 20 + jsonBytes.length;
  dv.setUint32(o, bin.length, true);
  dv.setUint32(o + 4, 0x004e4942, true);
  out.set(bin, o + 8);
  return out;
}

Deno.test("glTF: .glb and .gltf with embedded data, normals computed", async () => {
  for (const kind of ["glb", "data"] as const) {
    const bytes = quadGltf(kind);
    const mesh = await parseGltf(
      bytes.buffer.slice(0) as ArrayBuffer,
      "file:///x/quad.gltf",
    );
    assertEquals(mesh.positions.length, 12);
    assertEquals(Array.from(mesh.indices), [0, 1, 2, 0, 2, 3]);
    assertEquals(Array.from(mesh.uvs.slice(0, 2)), [0, 1]);
    // No NORMAL attribute: computed, facing +Z.
    assertEquals(Array.from(mesh.normals.slice(0, 3)), [0, 0, 1]);
  }
  let failed = false;
  try {
    await parseGltf(
      new TextEncoder().encode("{}").buffer as ArrayBuffer,
      "file:///x",
    );
  } catch {
    failed = true;
  }
  assert(failed);
});
