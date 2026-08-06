import { vec3, vec3_length } from "@ink/math/vector.ts";
import { assertEquals } from "@std/assert";
import { navigation_agent_id } from "./identity.ts";
import { NavigationMesh } from "./navmesh.ts";
import { update_crowd } from "./crowd.ts";
import { navigation_profile } from "./test_support.ts";

Deno.test("crowd steering is input-order independent and acceleration bounded", () => {
  const profile = navigation_profile();
  const snapshot = new NavigationMesh({ profile }).snapshot();
  const agents = [
    {
      id: navigation_agent_id("a"),
      position: vec3(0, 0, 0),
      velocity: vec3(0, 0, 0),
      path: [vec3(10, 0, 0)],
      profile,
    },
    {
      id: navigation_agent_id("b"),
      position: vec3(0, 0, 0),
      velocity: vec3(0, 0, 0),
      path: [vec3(10, 0, 0)],
      profile,
    },
  ];
  const options = {
    delta_seconds: 0.25,
    neighbor_distance: 2,
    obstacle_distance: 1,
  };
  const first = update_crowd(snapshot, agents, options);
  const second = update_crowd(snapshot, [...agents].reverse(), options);
  assertEquals(first, second);
  if (first.type !== "ready") throw new Error(first.type);
  assertEquals(first.outputs.map(({ agent }) => agent), ["a", "b"]);
  assertEquals(
    first.outputs.every(({ desired_velocity }) =>
      vec3_length(desired_velocity) <= profile.maximum_acceleration * 0.25
    ),
    true,
  );
  assertEquals(first.outputs[0].neighbors, [navigation_agent_id("b")]);
});

Deno.test("crowd updates report stale navigation revisions", () => {
  const profile = navigation_profile();
  const snapshot = new NavigationMesh({ profile }).snapshot();
  assertEquals(
    update_crowd(snapshot, [], {
      delta_seconds: 0.1,
      neighbor_distance: 2,
      obstacle_distance: 1,
      expected_revision: 4,
    }),
    {
      type: "stale",
      expected_revision: 4,
      current_revision: 0,
    },
  );
});
