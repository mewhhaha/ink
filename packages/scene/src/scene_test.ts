import { assertEquals } from "@std/assert";
import { aabb } from "@ink/geometry/shapes.ts";
import { quat_identity } from "@ink/math/quaternion.ts";
import { transform } from "@ink/math/transform.ts";
import { vec3 } from "@ink/math/vector.ts";
import { attachment_key, scene_id } from "./identity.ts";
import { apply_scene_delta, Scene } from "./scene.ts";

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

function created(result: ReturnType<Scene["create_node"]>) {
  if (result.type !== "created") throw new Error(result.reason);
  return result.id;
}

function translated(x: number, y: number, z: number) {
  return transform(vec3(x, y, z), quat_identity(), vec3(1, 1, 1));
}
