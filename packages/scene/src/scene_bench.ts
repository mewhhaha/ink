import { quat_identity } from "@ink/math/quaternion.ts";
import { transform } from "@ink/math/transform.ts";
import { vec3 } from "@ink/math/vector.ts";
import { scene_id } from "./identity.ts";
import { apply_scene_delta, Scene } from "./experimental/scene.ts";

const static_scene = new Scene({ id: scene_id("static") });
let parent = created(static_scene.create_node());
for (let index = 1; index < 10_000; index += 1) {
  parent = created(static_scene.create_node({ parent }));
}

Deno.bench("resolve a 10,000-node deep hierarchy", () => {
  const snapshot = static_scene.snapshot();
  if (snapshot.nodes.length !== 10_000) {
    throw new Error("scene benchmark lost nodes");
  }
});

Deno.bench("apply 1,000 animated node deltas", () => {
  const scene = new Scene({
    id: scene_id("animated"),
    delta_history_capacity: 1_100,
  });
  const nodes = Array.from(
    { length: 1_000 },
    () => created(scene.create_node()),
  );
  const before = scene.snapshot();
  for (const [index, node] of nodes.entries()) {
    scene.set_local_transform(
      node,
      transform(vec3(index, 0, 0), quat_identity(), vec3(1, 1, 1)),
    );
  }
  const delta = scene.delta_since(before.revision);
  if (delta.type !== "ready") throw new Error(delta.type);
  const result = apply_scene_delta(before, delta.delta);
  if (result.type !== "ready") throw new Error(result.reason);
});

function created(result: ReturnType<Scene["create_node"]>) {
  if (result.type !== "created") throw new Error(result.reason);
  return result.id;
}
