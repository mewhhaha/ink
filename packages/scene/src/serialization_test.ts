import { assertEquals } from "@std/assert";
import { asset_id, asset_ref } from "@ink/assets/identity.ts";
import { attachment_key, scene_id, scene_instance_id } from "./identity.ts";
import { Scene, type SceneOverrideProperty } from "./scene.ts";
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
    version: 2,
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

Deno.test("scene serialization preserves nested scene ownership and local overrides", () => {
  const source = new Scene({ id: scene_id("door") });
  const source_root = source.create_node({ name: "Door" });
  if (source_root.type !== "created") throw new Error(source_root.reason);
  const room = new Scene({ id: scene_id("room") });
  const nested = room.instantiate_scene(source.snapshot(), {
    instance: scene_instance_id("exit"),
  });
  if (nested.type !== "instantiated") throw new Error(nested.reason);
  room.set_active(nested.root, false);
  const codecs = new AttachmentCodecRegistry();

  const serialized = serialize_scene(room.snapshot(), codecs);
  if (serialized.type !== "ready") throw new Error(serialized.reason);
  const restored = parse_scene(serialized.source, "room.scene.json", codecs);
  if (restored.type !== "ready") throw new Error(restored.reason);

  assertEquals(restored.snapshot.nodes[0].instance, {
    instance: scene_instance_id("exit"),
    source_scene: scene_id("door"),
    source_node: source_root.id,
    overrides: new Set<SceneOverrideProperty>(["active"]),
  });
});

Deno.test("scene serialization rejects non-JSON attachment encodings", () => {
  const key = attachment_key<number>("test", "value");
  const codec = {
    key,
    encode: (_value: number) => Number.NaN as never,
    decode: (value: never) => value as number,
  };
  const codecs = new AttachmentCodecRegistry();
  codecs.register(codec);
  codec.encode = () => 1 as never;
  const scene = new Scene({ id: scene_id("invalid-attachment") });
  const node = scene.create_node();
  if (node.type !== "created") throw new Error(node.reason);
  scene.set_attachment(node.id, key, 1);

  assertEquals(serialize_scene(scene.snapshot(), codecs), {
    type: "failed",
    source: "serialize",
    field: "attachments.test:value",
    node: "0:0",
    reason: 'attachment "test:value" number NaN must be finite',
  });
});
