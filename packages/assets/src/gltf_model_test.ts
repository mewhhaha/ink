import { assertEquals, assertThrows } from "@std/assert";
import { parse_static_glb_scene } from "./gltf_model.ts";

Deno.test("static GLB scenes preserve indices with node transforms and material factors", () => {
  const scene = parse_static_glb_scene(triangle_glb(), "triangle.glb");

  assertEquals(scene.meshes.length, 1);
  assertEquals(scene.texture_reference_count, 0);
  assertEquals([...scene.meshes[0].indices], [0, 1, 2]);
  assertEquals(scene.meshes[0].material, {
    albedo: [0.25, 0.5, 0.75],
    emissive: [0.1, 0.2, 0.3],
    metallic: 0.4,
    roughness: 0.6,
  });
  assertEquals([...scene.meshes[0].vertices], [
    2,
    3,
    4,
    0,
    0,
    1,
    0,
    0,
    4,
    3,
    4,
    0,
    0,
    1,
    0,
    0,
    2,
    4,
    4,
    0,
    0,
    1,
    0,
    0,
  ]);
});

Deno.test("static GLB scenes reject primitives without normals at the boundary", () => {
  const document = triangle_document();
  const meshes = array(document.meshes);
  const mesh = record(meshes[0]);
  const primitives = array(mesh.primitives);
  const primitive = record(primitives[0]);
  primitive.attributes = { POSITION: 0 };

  assertThrows(
    () =>
      parse_static_glb_scene(glb(document, triangle_binary()), "broken.glb"),
    Error,
    'GLB "broken.glb" $.meshes[0].primitives[0].attributes.NORMAL',
  );
});

Deno.test("static GLB scenes retain embedded base-color textures and coordinates", () => {
  const document = triangle_document();
  document.buffers = [{ byteLength: 108 }];
  array(document.bufferViews).push(
    { buffer: 0, byteOffset: 80, byteLength: 24 },
    { buffer: 0, byteOffset: 104, byteLength: 4 },
  );
  array(document.accessors).push({
    bufferView: 3,
    componentType: 5126,
    count: 3,
    type: "VEC2",
  });
  const material = record(array(document.materials)[0]);
  record(material.pbrMetallicRoughness).baseColorTexture = { index: 0 };
  const primitive = record(
    array(record(array(document.meshes)[0]).primitives)[0],
  );
  primitive.attributes = {
    ...record(primitive.attributes),
    TEXCOORD_0: 3,
  };
  document.images = [{ bufferView: 4, mimeType: "image/png" }];
  document.textures = [{ source: 0 }];
  const binary = new Uint8Array(108);
  binary.set(triangle_binary());
  const view = new DataView(binary.buffer);
  [0, 0, 1, 0, 0, 1].forEach((value, index) =>
    view.setFloat32(80 + index * 4, value, true)
  );
  binary.set([137, 80, 78, 71], 104);

  const scene = parse_static_glb_scene(
    glb(document, binary),
    "textured.glb",
  );

  assertEquals(
    scene.meshes[0].material.base_color_texture,
    "textured.glb#texture/0",
  );
  assertEquals([...scene.textures[0].bytes], [137, 80, 78, 71]);
  assertEquals(scene.textures[0].mime_type, "image/png");
  assertEquals(
    [
      scene.meshes[0].vertices[6],
      scene.meshes[0].vertices[7],
      scene.meshes[0].vertices[14],
      scene.meshes[0].vertices[15],
      scene.meshes[0].vertices[22],
      scene.meshes[0].vertices[23],
    ],
    [0, 0, 1, 0, 0, 1],
  );
});

Deno.test("static GLB scenes retain embedded normal textures", () => {
  const document = triangle_document();
  document.buffers = [{ byteLength: 84 }];
  array(document.bufferViews).push({
    buffer: 0,
    byteOffset: 80,
    byteLength: 4,
  });
  const material = record(array(document.materials)[0]);
  material.normalTexture = { index: 0 };
  document.images = [{ bufferView: 3, mimeType: "image/png" }];
  document.textures = [{ source: 0 }];
  const binary = new Uint8Array(84);
  binary.set(triangle_binary());
  binary.set([137, 80, 78, 71], 80);

  const scene = parse_static_glb_scene(glb(document, binary), "normal.glb");

  assertEquals(
    scene.meshes[0].material.normal_texture,
    "normal.glb#texture/0",
  );
  assertEquals(scene.texture_reference_count, 1);
});

function triangle_glb(): Uint8Array {
  return glb(triangle_document(), triangle_binary());
}

function triangle_document(): Record<string, unknown> {
  return {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, translation: [2, 3, 4], scale: [2, 1, 1] }],
    buffers: [{ byteLength: 80 }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 36 },
      { buffer: 0, byteOffset: 72, byteLength: 6 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 1, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 2, componentType: 5123, count: 3, type: "SCALAR" },
    ],
    materials: [{
      pbrMetallicRoughness: {
        baseColorFactor: [0.25, 0.5, 0.75, 1],
        metallicFactor: 0.4,
        roughnessFactor: 0.6,
      },
      emissiveFactor: [0.1, 0.2, 0.3],
    }],
    meshes: [{
      primitives: [{
        attributes: { POSITION: 0, NORMAL: 1 },
        indices: 2,
        material: 0,
      }],
    }],
  };
}

function triangle_binary(): Uint8Array {
  const binary = new Uint8Array(80);
  const view = new DataView(binary.buffer);
  const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  const normals = [0, 0, 1, 0, 0, 1, 0, 0, 1];
  positions.forEach((value, index) => view.setFloat32(index * 4, value, true));
  normals.forEach((value, index) =>
    view.setFloat32(36 + index * 4, value, true)
  );
  [0, 1, 2].forEach((value, index) =>
    view.setUint16(72 + index * 2, value, true)
  );
  return binary;
}

function glb(
  document: Record<string, unknown>,
  binary: Uint8Array,
): Uint8Array {
  const encoded_json = new TextEncoder().encode(JSON.stringify(document));
  const json_length = Math.ceil(encoded_json.length / 4) * 4;
  const binary_length = Math.ceil(binary.length / 4) * 4;
  const bytes = new Uint8Array(12 + 8 + json_length + 8 + binary_length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.length, true);
  view.setUint32(12, json_length, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(0x20, 20, 20 + json_length);
  bytes.set(encoded_json, 20);
  const binary_header = 20 + json_length;
  view.setUint32(binary_header, binary_length, true);
  view.setUint32(binary_header + 4, 0x004e4942, true);
  bytes.set(binary, binary_header + 8);
  return bytes;
}

function record(value: unknown): Record<string, unknown> {
  if (!is_record(value)) throw new Error("test fixture expected an object");
  return value;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("test fixture expected an array");
  return value;
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
