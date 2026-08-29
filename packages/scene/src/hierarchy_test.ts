import { assertEquals, assertStringIncludes } from "@std/assert";
import { transform } from "@ink/math/transform.ts";
import { quat_identity } from "@ink/math/quaternion.ts";
import { vec3 } from "@ink/math/vector.ts";
import { resolve_scene } from "./hierarchy.ts";
import { scene_id, scene_node_id } from "./identity.ts";

const identity = () => transform(vec3(0, 0, 0), quat_identity(), vec3(1, 1, 1));

Deno.test("immutable scene hierarchy resolves parent transforms and visibility", () => {
  const result = resolve_scene({
    id: scene_id("level"),
    revision: 4,
    nodes: [
      {
        id: scene_node_id(0, 0),
        local_transform: transform(
          vec3(2, 0, 0),
          quat_identity(),
          vec3(1, 1, 1),
        ),
        active: false,
        layers: 0b0111,
      },
      {
        id: scene_node_id(1, 0),
        parent: scene_node_id(0, 0),
        local_transform: transform(
          vec3(3, 0, 0),
          quat_identity(),
          vec3(1, 1, 1),
        ),
        active: true,
        layers: 0b1101,
      },
    ],
  });

  if (result.type !== "ready") throw new Error(result.reason);
  assertEquals(result.scene.nodes[1].world_transform[12], 5);
  assertEquals(result.scene.nodes[1].world_active, false);
  assertEquals(result.scene.nodes[1].world_layers, 0b0101);
});

Deno.test("immutable scene hierarchy reports an unknown parent with both ids", () => {
  const result = resolve_scene({
    id: scene_id("level"),
    revision: 0,
    nodes: [{
      id: scene_node_id(2, 0),
      parent: scene_node_id(7, 0),
      local_transform: identity(),
      active: true,
      layers: 1,
    }],
  });

  if (result.type === "ready") throw new Error("invalid scene resolved");
  assertStringIncludes(result.reason, "scene node 2:0 has unknown parent 7:0");
  assertEquals(result.path, [scene_node_id(2, 0), scene_node_id(7, 0)]);
});

Deno.test("immutable scene hierarchy reports the complete parent cycle", () => {
  const result = resolve_scene({
    id: scene_id("level"),
    revision: 0,
    nodes: [
      {
        id: scene_node_id(1, 0),
        parent: scene_node_id(2, 0),
        local_transform: identity(),
        active: true,
        layers: 1,
      },
      {
        id: scene_node_id(2, 0),
        parent: scene_node_id(1, 0),
        local_transform: identity(),
        active: true,
        layers: 1,
      },
    ],
  });

  if (result.type === "ready") throw new Error("cyclic scene resolved");
  assertStringIncludes(result.reason, "1:0 -> 2:0 -> 1:0");
});
