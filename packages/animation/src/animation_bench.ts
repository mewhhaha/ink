import { asset_id } from "@ink/assets/identity.ts";
import { quat_identity } from "@ink/math/quaternion.ts";
import { transform, transform_identity } from "@ink/math/transform.ts";
import { vec3 } from "@ink/math/vector.ts";
import { compress_clip, create_clip } from "./clip.ts";
import { AnimationGraphInstance, create_graph } from "./graph.ts";
import { bind_pose, blend_poses, skin_matrices } from "./pose.ts";
import { create_skeleton } from "./skeleton.ts";

const skeleton = create_skeleton(
  asset_id<"skeleton">("bench.skeleton"),
  Array.from({ length: 100 }, (_, index) => ({
    id: `joint-${index}`,
    ...(index === 0 ? {} : { parent: `joint-${index - 1}` }),
    bind_transform: index === 0
      ? transform_identity()
      : transform(vec3(0, 0.1, 0), quat_identity(), vec3(1, 1, 1)),
  })),
);
const clip_asset = asset_id<"animation">("bench.animation");
const clip = create_clip(skeleton, {
  asset: clip_asset,
  duration: 1,
  looping: true,
  tracks: skeleton.joints.map((joint) => ({
    joint: joint.id,
    interpolation: "linear" as const,
    positions: Array.from({ length: 10 }, (_, index) => ({
      time: index / 9,
      value: vec3(index / 9, joint.index * 0.01, 0),
    })),
  })),
  properties: [],
  morphs: [],
  events: [],
});
const graph_asset = asset_id<"animation.graph">("bench.graph");
const clips = new Map([[clip_asset, clip]]);
const graph = create_graph({
  asset: graph_asset,
  initial: "motion",
  parameters: {},
  states: [{ id: "motion", node: { type: "clip", clip: clip_asset } }],
  transitions: [],
}, clips);
const instance = new AnimationGraphInstance({ graph, skeleton, clips });
const first = bind_pose(skeleton);
const second = {
  transforms: first.transforms.map((source, index) =>
    transform(vec3(index, 0, 0), source.rotation, source.scale)
  ),
};
const crowd = Array.from(
  { length: 128 },
  () => new AnimationGraphInstance({ graph, skeleton, clips }),
);

Deno.bench("evaluate a 100-joint graph", () => {
  instance.step(1 / 60);
});
Deno.bench("blend two 100-joint poses", () => {
  blend_poses(first, second, 0.5);
});
Deno.bench("generate 100 skin matrices", () => {
  skin_matrices(skeleton, second);
});
Deno.bench(
  "compress 1,000 transform keys",
  () => {
    compress_clip(skeleton, clip, 1e-6);
  },
);
Deno.bench("evaluate a 128-character crowd", () => {
  for (const character of crowd) character.step(1 / 60);
});
