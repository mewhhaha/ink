import { assertEquals } from "@std/assert";
import { asset_id, asset_ref } from "@ink/assets/identity.ts";
import { scene_id } from "./identity.ts";
import { Scene } from "./scene.ts";
import {
  asset_attachment_key,
  asset_reference_codec,
  AttachmentCodecRegistry,
  parse_scene,
  serialize_scene,
} from "./serialization.ts";

Deno.test("scene serialization round trips registered asset references deterministically", () => {
  const mesh_key = asset_attachment_key<"mesh">("mesh");
  const codecs = new AttachmentCodecRegistry();
  codecs.register(asset_reference_codec(mesh_key, "mesh"));
  const scene = new Scene({ id: scene_id("fixture") });
  const created = scene.create_node({ name: "crate" });
  if (created.type !== "created") throw new Error(created.reason);
  scene.set_attachment(
    created.id,
    mesh_key,
    asset_ref(asset_id<"mesh">("models/crate"), "mesh"),
  );

  const serialized = serialize_scene(scene.snapshot(), codecs);
  if (serialized.type !== "ready") throw new Error(serialized.reason);
  const restored = parse_scene(serialized.source, "fixture.scene.json", codecs);
  if (restored.type !== "ready") throw new Error(restored.reason);
  assertEquals(
    serialize_scene(restored.snapshot, codecs),
    serialized,
  );
});

Deno.test("scene deserialization reports an unregistered attachment with node evidence", () => {
  const source = JSON.stringify({
    version: 1,
    scene_id: "fixture",
    revision: 1,
    nodes: [{
      id: [0, 0],
      local_transform: {
        position: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
      active: true,
      layers: 1,
      attachments: { "missing:codec": {} },
    }],
  });
  assertEquals(
    parse_scene(source, "fixture.scene.json", new AttachmentCodecRegistry()),
    {
      type: "failed",
      source: "fixture.scene.json",
      field: "$.nodes[0].attachments.missing:codec",
      node: "0:0",
      reason: 'attachment codec "missing:codec" is not registered',
    },
  );
});
