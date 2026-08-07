import { assertEquals } from "@std/assert";
import { aabb } from "@ink/geometry/shapes.ts";
import { quat_identity } from "@ink/math/quaternion.ts";
import { transform } from "@ink/math/transform.ts";
import { vec3 } from "@ink/math/vector.ts";
import {
  attachment_key,
  scene_id,
  scene_instance_id,
  scene_node_equal,
  scene_node_id,
  scene_node_key,
} from "./identity.ts";
import {
  apply_scene_delta,
  resolve_scene_snapshot,
  Scene,
  type SceneOverrideProperty,
} from "./scene.ts";

Deno.test("scene snapshots resolve hierarchy transforms, activation, layers, and bounds", () => {
  const scene = new Scene({ id: scene_id("fixture") });
  const parent = scene.create_node({
    local_transform: translated(10, 0, 0),
    active: false,
    layers: 0b0110,
  });
  if (parent.type !== "created") throw new Error(parent.reason);
  const child = scene.create_node({
    parent: parent.id,
    local_transform: translated(0, 2, 0),
    layers: 0b0011,
    local_bounds: aabb(vec3(-1, -1, -1), vec3(1, 1, 1)),
  });
  if (child.type !== "created") throw new Error(child.reason);

  const resolved = scene.snapshot().nodes.find((node) =>
    node.id.index === child.id.index
  )!;
  assertEquals([resolved.world_transform[12], resolved.world_transform[13]], [
    10,
    2,
  ]);
  assertEquals(resolved.world_active, false);
  assertEquals(resolved.world_layers, 0b0010);
  assertEquals(resolved.world_bounds?.minimum, vec3(9, 1, -1));
  assertEquals(resolved.depth, 1);
});

Deno.test("scene reparenting rejects cycles with the complete offending path", () => {
  const scene = new Scene({ id: scene_id("fixture") });
  const root = created(scene.create_node());
  const middle = created(scene.create_node({ parent: root }));
  const leaf = created(scene.create_node({ parent: middle }));

  assertEquals(scene.reparent(root, leaf), {
    type: "failed",
    reason: "parent_cycle",
    node: root,
    path: [root, leaf, middle, root],
  });
});

Deno.test("removed indices reject stale handles after deterministic recycling", () => {
  const scene = new Scene({ id: scene_id("fixture") });
  const removed = created(scene.create_node());
  scene.remove_subtree(removed);
  const replacement = created(scene.create_node());

  assertEquals(replacement.index, removed.index);
  assertEquals(replacement.generation, removed.generation + 1);
  assertEquals(scene.set_active(removed, false), {
    type: "failed",
    reason: "stale_node",
    node: removed,
    current_generation: replacement.generation,
  });
});

Deno.test("incremental deltas produce the same snapshot as a full rebuild", () => {
  const scene = new Scene({ id: scene_id("fixture") });
  const root = created(scene.create_node());
  const child = created(scene.create_node({ parent: root }));
  const before = scene.snapshot();
  scene.set_local_transform(child, translated(4, 5, 6));
  scene.set_active(root, false);
  const delta = scene.delta_since(before.revision);
  if (delta.type !== "ready") throw new Error(delta.type);
  const applied = apply_scene_delta(before, delta.delta);
  if (applied.type !== "ready") throw new Error(applied.reason);

  assertEquals(applied.snapshot, scene.snapshot());
});

Deno.test("removing a parent reparents children before the parent disappears", () => {
  const scene = new Scene({ id: scene_id("fixture") });
  const root = created(scene.create_node());
  const removed = created(scene.create_node({ parent: root }));
  const child = created(scene.create_node({ parent: removed }));
  const result = scene.remove_and_reparent_children(removed);
  if (result.type !== "changed") throw new Error(result.reason);

  assertEquals(result.delta.operations.map((operation) => operation.type), [
    "upsert",
    "remove",
  ]);
  assertEquals(
    scene.snapshot().nodes.find((node) => node.id.index === child.index)
      ?.parent,
    root,
  );
});

Deno.test("attachments are copied into snapshots and cannot mutate scene authority", () => {
  const scene = new Scene({ id: scene_id("fixture") });
  const node = created(scene.create_node());
  const label = attachment_key<string>("test", "label");
  scene.set_attachment(node, label, "ready");
  const snapshot = scene.snapshot();
  (snapshot.nodes[0].attachments as Map<string, unknown>).set(label, "changed");
  assertEquals(scene.snapshot().nodes[0].attachments.get(label), "ready");
});

Deno.test("wide scenes retain deterministic node order", () => {
  const scene = new Scene({ id: scene_id("wide") });
  for (let index = 0; index < 1_000; index += 1) scene.create_node();
  assertEquals(
    scene.snapshot().nodes.map((node) => node.id.index),
    Array.from({ length: 1_000 }, (_, index) => index),
  );
});

Deno.test("scenes instantiate as nested scenes with stable source ownership", () => {
  const character = new Scene({ id: scene_id("character") });
  const character_root = created(character.create_node({ name: "Character" }));
  const weapon = created(character.create_node({
    name: "Weapon",
    parent: character_root,
  }));
  const level = new Scene({ id: scene_id("level") });
  const level_root = created(level.create_node({ name: "Level" }));

  const result = level.instantiate_scene(character.snapshot(), {
    instance: scene_instance_id("player"),
    parent: level_root,
    local_transform: translated(5, 0, 0),
  });
  if (result.type !== "instantiated") throw new Error(result.reason);

  const snapshot = level.snapshot();
  const root = snapshot.nodes.find((node) =>
    scene_node_equal(node.id, result.root)
  )!;
  const mapped_weapon = result.nodes.get(scene_node_key(weapon))!;
  const child = snapshot.nodes.find((node) =>
    scene_node_equal(node.id, mapped_weapon)
  )!;
  assertEquals(root.parent, level_root);
  assertEquals(root.world_transform[12], 5);
  assertEquals(root.instance, {
    instance: scene_instance_id("player"),
    source_scene: scene_id("character"),
    source_node: character_root,
    overrides: new Set<SceneOverrideProperty>(["local_transform"]),
  });
  assertEquals(child.parent, result.root);
  assertEquals(child.instance?.source_node, weapon);
});

Deno.test("edits to nested scene nodes are recorded as local overrides", () => {
  const source = new Scene({ id: scene_id("lamp") });
  const source_root = created(source.create_node({ name: "Lamp" }));
  const target = new Scene({ id: scene_id("room") });
  const result = target.instantiate_scene(source.snapshot(), {
    instance: scene_instance_id("desk-lamp"),
  });
  if (result.type !== "instantiated") throw new Error(result.reason);

  target.set_active(result.root, false);
  target.set_name(result.root, "Reading lamp");
  assertEquals(
    [...target.snapshot().nodes[0].instance!.overrides].sort(),
    ["active", "name"],
  );
  assertEquals(target.snapshot().nodes[0].instance?.source_node, source_root);
});

Deno.test("a scene cannot instantiate itself or reuse an active instance identity", () => {
  const source = new Scene({ id: scene_id("actor") });
  created(source.create_node());
  const target = new Scene({ id: scene_id("level") });
  const instance = scene_instance_id("actor-1");
  const first = target.instantiate_scene(source.snapshot(), { instance });
  if (first.type !== "instantiated") throw new Error(first.reason);

  assertEquals(target.instantiate_scene(source.snapshot(), { instance }), {
    type: "failed",
    reason: "duplicate_instance",
    instance,
    source_scene: source.id,
  });
  assertEquals(source.instantiate_scene(source.snapshot(), { instance }), {
    type: "failed",
    reason: "cyclic_scene",
    instance,
    source_scene: source.id,
  });
});

Deno.test("nested source ownership cannot introduce an indirect scene cycle", () => {
  const source = new Scene({ id: scene_id("source") });
  created(source.create_node());
  const target = new Scene({ id: scene_id("target") });
  const snapshot = source.snapshot();
  const cyclic_source = {
    ...snapshot,
    nodes: [{
      ...snapshot.nodes[0],
      instance: {
        instance: scene_instance_id("nested-target"),
        source_scene: target.id,
        source_node: scene_node_id(0, 0),
        overrides: new Set<SceneOverrideProperty>(),
      },
    }],
  };

  assertEquals(
    target.instantiate_scene(cyclic_source, {
      instance: scene_instance_id("source-instance"),
    }),
    {
      type: "failed",
      reason: "cyclic_scene",
      instance: scene_instance_id("source-instance"),
      source_scene: source.id,
    },
  );
  assertEquals(target.revision, 0);
});

Deno.test("delta application rejects unknown removals and duplicate generations", () => {
  const scene = new Scene({ id: scene_id("delta") });
  created(scene.create_node());
  const snapshot = scene.snapshot();
  const unknown = scene_node_id(9, 0);
  assertEquals(
    apply_scene_delta(snapshot, {
      scene_id: scene.id,
      from_revision: snapshot.revision,
      to_revision: snapshot.revision + 1,
      operations: [{ type: "remove", id: unknown }],
    }),
    {
      type: "invalid_hierarchy",
      reason: "delta removes unknown scene node 9:0",
      path: [unknown],
    },
  );
  const duplicate_generation = resolve_scene_snapshot(
    scene.id,
    snapshot.revision,
    [snapshot.nodes[0], {
      ...snapshot.nodes[0],
      id: scene_node_id(snapshot.nodes[0].id.index, 1),
    }],
  );
  assertEquals(duplicate_generation.type, "invalid_hierarchy");
});

Deno.test("invalid source scenes are rejected before the target changes", () => {
  const source = new Scene({ id: scene_id("invalid-source") });
  created(source.create_node());
  const snapshot = source.snapshot();
  const target = new Scene({ id: scene_id("target") });
  const instance = scene_instance_id("invalid-instance");

  assertEquals(
    target.instantiate_scene({
      ...snapshot,
      nodes: [{ ...snapshot.nodes[0], parent: scene_node_id(99, 0) }],
    }, { instance }),
    {
      type: "failed",
      reason: "invalid_source",
      instance,
      source_scene: source.id,
      source_reason: "scene node 0:0 has unknown parent 99:0",
      source_path: [snapshot.nodes[0].id, scene_node_id(99, 0)],
    },
  );
  assertEquals(target.revision, 0);
  assertEquals(target.snapshot().nodes, []);
});

function created(result: ReturnType<Scene["create_node"]>) {
  if (result.type !== "created") throw new Error(result.reason);
  return result.id;
}

function translated(x: number, y: number, z: number) {
  return transform(vec3(x, y, z), quat_identity(), vec3(1, 1, 1));
}
