import { assertEquals } from "@std/assert";
import { parse_glb, parse_gltf_json } from "./gltf.ts";

Deno.test("glTF parsing separates meshes, materials, nodes, skins, animations, and scenes", () => {
  const result = parse_gltf_json(
    JSON.stringify({
      asset: { version: "2.0" },
      accessors: [{}, {}],
      materials: [{ name: "stone" }],
      meshes: [{
        name: "body",
        primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }],
      }],
      nodes: [{ name: "root", mesh: 0, skin: 0 }],
      skins: [{ joints: [0] }],
      animations: [{ name: "idle", channels: [{}], samplers: [{}] }],
      scenes: [{ name: "main", nodes: [0] }],
      scene: 0,
    }),
    "character.gltf",
  );

  if (result.type !== "ready") throw new Error(result.reason);
  assertEquals(result.document.meshes[0].id, "character.gltf#mesh/0");
  assertEquals(result.document.materials[0].id, "character.gltf#material/0");
  assertEquals(result.document.nodes[0].mesh, 0);
  assertEquals(result.document.skins[0].joints, [0]);
  assertEquals(result.document.animations[0].channel_count, 1);
  assertEquals(result.document.scenes[0].nodes, [0]);
  assertEquals(result.document.default_scene, 0);
});

Deno.test("glTF parsing rejects cross-record indices outside their target array", () => {
  const result = parse_gltf_json(
    JSON.stringify({
      asset: { version: "2.0" },
      nodes: [{ mesh: 2 }],
    }),
    "broken.gltf",
  );
  assertEquals(result, {
    type: "invalid_gltf",
    source: "broken.gltf",
    field: "$.nodes[0].mesh",
    reason: "$.nodes[0].mesh 2 is outside 0..-1",
  });
});

Deno.test("glTF parsing rejects cyclic and multiply-parented node hierarchies", () => {
  const cyclic = parse_gltf_json(
    JSON.stringify({
      asset: { version: "2.0" },
      nodes: [{ children: [1] }, { children: [0] }],
    }),
    "cyclic.gltf",
  );
  assertEquals(cyclic.type, "invalid_gltf");
  if (cyclic.type === "invalid_gltf") {
    assertEquals(
      cyclic.reason,
      "glTF node hierarchy contains a cycle through node 0",
    );
  }

  const multiple = parse_gltf_json(
    JSON.stringify({
      asset: { version: "2.0" },
      nodes: [{ children: [2] }, { children: [2] }, {}],
    }),
    "multiple.gltf",
  );
  assertEquals(multiple.type, "invalid_gltf");
  if (multiple.type === "invalid_gltf") {
    assertEquals(multiple.reason, "glTF node 2 has parents 0 and 1");
  }
});

Deno.test("GLB parsing extracts its JSON and binary chunks", () => {
  const json = new TextEncoder().encode('{"asset":{"version":"2.0"}}   ');
  const binary = new Uint8Array([1, 2, 3, 4]);
  const bytes = glb(json, binary);
  const result = parse_glb(bytes, "empty.glb");

  if (result.type !== "ready") throw new Error(result.reason);
  assertEquals(result.document.binary_chunk, binary);

  const invalid = bytes.slice();
  new DataView(invalid.buffer).setUint32(16, 0x004e4942, true);
  assertEquals(parse_glb(invalid, "invalid.glb"), {
    type: "invalid_gltf",
    source: "invalid.glb",
    field: "$",
    offset: 12,
    reason: "GLB first chunk must contain JSON",
  });
});

function glb(json: Uint8Array, binary: Uint8Array): Uint8Array {
  const json_length = Math.ceil(json.length / 4) * 4;
  const binary_length = Math.ceil(binary.length / 4) * 4;
  const bytes = new Uint8Array(12 + 8 + json_length + 8 + binary_length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.length, true);
  view.setUint32(12, json_length, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(0x20, 20, 20 + json_length);
  bytes.set(json, 20);
  const binary_offset = 20 + json_length;
  view.setUint32(binary_offset, binary_length, true);
  view.setUint32(binary_offset + 4, 0x004e4942, true);
  bytes.set(binary, binary_offset + 8);
  return bytes;
}
