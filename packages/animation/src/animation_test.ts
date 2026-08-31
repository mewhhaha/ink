import { assert, assertEquals, assertThrows } from "@std/assert";
import { asset_id } from "@ink/assets/identity.ts";
import { quat_from_axis_angle, quat_identity } from "@ink/math/quaternion.ts";
import { transform, transform_identity } from "@ink/math/transform.ts";
import { vec3 } from "@ink/math/vector.ts";
import { scene_node_id } from "@ink/scene/identity.ts";
import {
  type AnimationClip,
  compress_clip,
  create_clip,
  root_motion_delta,
  sample_clip,
  traverse_events,
} from "./clip.ts";
import {
  rendering_output,
  scene_transform_writes,
} from "./experimental/adapters.ts";
import {
  apply_look_at,
  apply_two_bone_ik,
} from "./experimental/constraints.ts";
import {
  type AnimationGraph,
  AnimationGraphInstance,
  create_graph,
} from "./experimental/graph.ts";
import {
  create_retarget_profile,
  retarget_pose,
} from "./experimental/retargeting.ts";
import {
  bind_pose,
  blend_poses,
  create_joint_mask,
  create_pose,
  skin_matrices,
} from "./pose.ts";
import { create_skeleton, joint_id } from "./skeleton.ts";

const skeleton_asset = asset_id<"skeleton">("hero.skeleton");
const clip_asset = asset_id<"animation">("walk.animation");
const graph_asset = asset_id<"animation.graph">("locomotion.graph");

function chain() {
  return create_skeleton(skeleton_asset, [
    {
      id: "root",
      bind_transform: transform_identity(),
    },
    {
      id: "knee",
      parent: "root",
      bind_transform: transform(vec3(0, 1, 0), quat_identity(), vec3(1, 1, 1)),
    },
    {
      id: "foot",
      parent: "knee",
      bind_transform: transform(vec3(0, 1, 0), quat_identity(), vec3(1, 1, 1)),
    },
  ]);
}

function clip(looping = true): AnimationClip {
  return create_clip(chain(), {
    asset: clip_asset,
    duration: 1,
    looping,
    root_joint: joint_id("root"),
    tracks: [{
      joint: joint_id("root"),
      interpolation: "linear",
      positions: [{ time: 0, value: vec3(0, 0, 0) }, {
        time: 0.5,
        value: vec3(1, 0, 0),
      }, { time: 1, value: vec3(2, 0, 0) }],
      rotations: [{ time: 0, value: quat_identity() }, {
        time: 1,
        value: quat_from_axis_angle(vec3(0, 1, 0), Math.PI),
      }],
    }],
    properties: [{
      property: "speed",
      interpolation: "step",
      default_value: 0,
      keys: [{ time: 0, value: 1 }, { time: 0.5, value: 2 }],
    }],
    morphs: [{
      morph: "smile",
      interpolation: "cubic",
      default_weight: 0,
      keys: [{ time: 0, value: 0 }, { time: 1, value: 1 }],
    }],
    events: [{ time: 0.25, name: "left" }, { time: 0.75, name: "right" }],
  });
}

Deno.test("skeleton accepts empty, one, and parent-ordered joint sets", () => {
  assertEquals(create_skeleton(skeleton_asset, []).joints.length, 0);
  assertEquals(
    create_skeleton(skeleton_asset, [{
      id: "root",
      bind_transform: transform_identity(),
    }]).joints.length,
    1,
  );
  assertEquals(chain().joints.map(({ parent }) => parent), [null, 0, 1]);
});

Deno.test("skeleton parsing rejects duplicates, cycles, and missing parents with asset evidence", () => {
  assertThrows(
    () =>
      create_skeleton(skeleton_asset, [
        { id: "child", parent: "root", bind_transform: transform_identity() },
        { id: "root", bind_transform: transform_identity() },
      ]),
    Error,
    "hero.skeleton joint child parent root",
  );
  assertThrows(
    () =>
      create_skeleton(skeleton_asset, [
        { id: "root", bind_transform: transform_identity() },
        { id: "root", bind_transform: transform_identity() },
      ]),
    Error,
    "repeats joint",
  );
});

Deno.test("retarget profiles map poses by semantic and preserve unmapped bind transforms", () => {
  const source_skeleton = chain();
  const target_skeleton = create_skeleton(
    asset_id<"skeleton">("target.skeleton"),
    [{
      id: "pelvis",
      bind_transform: transform_identity(),
    }, {
      id: "hand",
      parent: "pelvis",
      bind_transform: transform(
        vec3(0, 3, 0),
        quat_identity(),
        vec3(1, 1, 1),
      ),
    }],
  );
  const source_profile = create_retarget_profile(source_skeleton, [{
    joint: "root",
    semantic: "hips",
    translation_scale: 2,
  }]);
  const target_profile = create_retarget_profile(target_skeleton, [{
    joint: "pelvis",
    semantic: "hips",
    translation_scale: 4,
  }, {
    joint: "hand",
    semantic: "hand",
  }]);
  const source_pose = create_pose(source_skeleton, [
    transform(vec3(2, 0, 0), quat_identity(), vec3(1, 1, 1)),
    ...bind_pose(source_skeleton).transforms.slice(1),
  ]);

  const result = retarget_pose(
    { profile: source_profile, pose: source_pose },
    target_profile,
  );

  assertEquals(result.transforms[0].position, vec3(4, 0, 0));
  assertEquals(result.transforms[1], target_skeleton.joints[1].bind_transform);
});

Deno.test("retarget profiles reject repeated semantics with both joint identities", () => {
  assertThrows(
    () =>
      create_retarget_profile(chain(), [{
        joint: "root",
        semantic: "leg",
      }, {
        joint: "knee",
        semantic: "leg",
      }]),
    Error,
    "joints root and knee repeat semantic leg",
  );
});

Deno.test("retarget profiles reject blank semantics at the authored boundary", () => {
  assertThrows(
    () =>
      create_retarget_profile(chain(), [{
        joint: "root",
        semantic: "   ",
      }]),
    Error,
    "joint root semantic cannot be empty",
  );
});

Deno.test("retarget profiles reject nonpositive translation scales", () => {
  assertThrows(
    () =>
      create_retarget_profile(chain(), [{
        joint: "root",
        semantic: "hips",
        translation_scale: 0,
      }]),
    Error,
    "joint root translation scale 0 must be positive",
  );
});

Deno.test("clip sampling applies linear, spherical, step, cubic, and bind fallbacks", () => {
  const sampled = sample_clip(chain(), clip(false), 0.5);
  assertEquals(sampled.pose.transforms[0].position, vec3(1, 0, 0));
  assertEquals(sampled.pose.transforms[1].position, vec3(0, 1, 0));
  assertEquals(sampled.properties.get("speed"), 1);
  assert(Math.abs(sampled.morph_weights.get("smile")! - 0.5) < 1e-9);
  assert(Math.abs(sampled.pose.transforms[0].rotation.w - Math.SQRT1_2) < 1e-9);
});

Deno.test("clip parsing snapshots authored keys and rejects empty channels", () => {
  const position_key = { time: 0, value: vec3(3, 0, 0) };
  const animation = create_clip(chain(), {
    asset: clip_asset,
    duration: 1,
    looping: false,
    tracks: [{
      joint: joint_id("root"),
      interpolation: "linear",
      positions: [position_key],
    }],
    properties: [],
    morphs: [],
    events: [],
  });
  position_key.time = 0.5;
  assertEquals(
    sample_clip(chain(), animation, 0).pose.transforms[0].position,
    vec3(3, 0, 0),
  );
  assertThrows(
    () =>
      create_clip(chain(), {
        ...animation,
        tracks: [{
          joint: joint_id("root"),
          interpolation: "linear",
          positions: [],
        }],
      }),
    Error,
    "root positions cannot be empty",
  );
});

Deno.test("clip parsing rejects non-finite scalar values", () => {
  assertThrows(
    () =>
      create_clip(chain(), {
        asset: clip_asset,
        duration: 1,
        looping: false,
        tracks: [],
        properties: [{
          property: "speed",
          interpolation: "linear",
          default_value: 0,
          keys: [{ time: 0, value: Number.NaN }],
        }],
        morphs: [],
        events: [],
      }),
    Error,
    "property speed key 0 values must be finite",
  );
});

Deno.test("loop and reverse traversal order every crossed event once", () => {
  const animation = clip();
  assertEquals(traverse_events(animation, 0.1, 1.8).map(({ name }) => name), [
    "left",
    "right",
    "left",
    "right",
  ]);
  assertEquals(traverse_events(animation, 1.8, 0.1).map(({ name }) => name), [
    "right",
    "left",
    "right",
    "left",
  ]);
  assertThrows(
    () => traverse_events(animation, 0, Number.POSITIVE_INFINITY),
    Error,
    "event traversal 0..Infinity must be finite",
  );
});

Deno.test("root motion remains continuous across forward and reverse loop boundaries", () => {
  const animation = clip();
  assertEquals(
    root_motion_delta(chain(), animation, 0.75, 1.25).translation,
    vec3(1, 0, 0),
  );
  assertEquals(
    root_motion_delta(chain(), animation, 1.25, 0.75).translation,
    vec3(-1, 0, 0),
  );
  assertThrows(
    () => root_motion_delta(chain(), animation, Number.NaN, Number.NaN),
    Error,
    "root motion NaN..NaN must be finite",
  );
});

Deno.test("masks blend only selected joints and propagate to descendants", () => {
  const skeleton = chain();
  const first = bind_pose(skeleton);
  const changed = {
    transforms: first.transforms.map((value) =>
      transform(vec3(2, 2, 2), value.rotation, value.scale)
    ),
  };
  const mask = create_joint_mask(skeleton, { knee: 1 }, true);
  const result = blend_poses(first, changed, 1, mask);
  assertEquals(result.transforms[0].position, vec3(0, 0, 0));
  assertEquals(result.transforms[1].position, vec3(2, 2, 2));
  assertEquals(result.transforms[2].position, vec3(2, 2, 2));
});

Deno.test("bounded look-at and two-bone IK preserve finite poses", () => {
  const skeleton = chain();
  const looked = apply_look_at(
    skeleton,
    bind_pose(skeleton),
    joint_id("root"),
    vec3(2, 0, 2),
    vec3(0, 0, 1),
    0.2,
  );
  const solved = apply_two_bone_ik(
    skeleton,
    looked,
    joint_id("root"),
    joint_id("knee"),
    joint_id("foot"),
    vec3(1, 1, 0),
    vec3(0, 0, 1),
  );
  assert(Number.isFinite(solved.transforms[0].rotation.w));
  assertThrows(
    () =>
      apply_two_bone_ik(
        skeleton,
        solved,
        joint_id("root"),
        joint_id("foot"),
        joint_id("knee"),
        vec3(1, 1, 0),
        vec3(0, 0, 1),
      ),
    Error,
    "not a direct chain",
  );
  assertThrows(
    () =>
      apply_look_at(
        skeleton,
        solved,
        joint_id("root"),
        solved.transforms[0].position,
        vec3(0, 0, 1),
        -1,
      ),
    Error,
    "maximum radians -1 must be nonnegative",
  );
  assertThrows(
    () => skin_matrices(skeleton, { transforms: solved.transforms.slice(1) }),
    Error,
    "global pose skeleton hero.skeleton has 3 joints but pose has 2",
  );
});

Deno.test("compression removes redundant keys within the measured threshold", () => {
  const result = compress_clip(chain(), clip(), 1e-9);
  assertEquals(result.removed_keys, 1);
  assert(result.maximum_error <= 1e-9);
  assertEquals(
    sample_clip(chain(), result.clip, 0.5).pose.transforms[0].position,
    vec3(1, 0, 0),
  );
});

Deno.test("compression reports only introduced error and preserves cubic tracks", () => {
  const skeleton = chain();
  const nonlinear = create_clip(skeleton, {
    asset: clip_asset,
    duration: 1,
    looping: false,
    tracks: [{
      joint: joint_id("root"),
      interpolation: "linear",
      positions: [{ time: 0, value: vec3(0, 0, 0) }, {
        time: 0.5,
        value: vec3(0, 10, 0),
      }, { time: 1, value: vec3(0, 0, 0) }],
    }],
    properties: [],
    morphs: [],
    events: [],
  });
  const unchanged = compress_clip(skeleton, nonlinear, 0);
  assertEquals(unchanged.removed_keys, 0);
  assertEquals(unchanged.maximum_error, 0);

  const cubic = create_clip(skeleton, {
    ...nonlinear,
    tracks: [{
      joint: joint_id("root"),
      interpolation: "cubic",
      positions: [{ time: 0, value: vec3(0, 0, 0) }, {
        time: 0.5,
        value: vec3(0, 0, 0),
      }, { time: 1, value: vec3(0, 0, 0) }],
    }],
  });
  assertEquals(compress_clip(skeleton, cubic, 1).removed_keys, 0);
});

function graph(
  animation: AnimationClip,
): {
  graph: AnimationGraph;
  clips: Map<ReturnType<typeof asset_id<"animation">>, AnimationClip>;
} {
  const idle_asset = asset_id<"animation">("idle.animation");
  const idle = create_clip(chain(), {
    ...animation,
    asset: idle_asset,
    tracks: [],
  });
  const clips = new Map([[animation.asset, animation], [idle.asset, idle]]);
  return {
    graph: create_graph({
      asset: graph_asset,
      initial: "idle",
      parameters: { moving: false, blend: 0.5, additive: 0 },
      states: [{ id: "idle", node: { type: "clip", clip: idle_asset } }, {
        id: "walk",
        node: {
          type: "blend",
          parameter: "blend",
          minimum: 0,
          maximum: 1,
          first: { type: "clip", clip: idle_asset },
          second: { type: "clip", clip: animation.asset },
        },
      }],
      transitions: [{
        from: "idle",
        to: "walk",
        duration: 0.2,
        synchronize: true,
        conditions: [{ parameter: "moving", operator: "equal", value: true }],
      }],
    }, clips),
    clips,
  };
}

Deno.test("graph transitions synchronize, blend, interrupt deterministically, and restore", () => {
  const skeleton = chain();
  const fixture = graph(clip());
  const instance = new AnimationGraphInstance({
    graph: fixture.graph,
    skeleton,
    clips: fixture.clips,
  });
  instance.step(0.1);
  instance.set_parameter("moving", true);
  const transitioning = instance.step(0.1);
  assertEquals(transitioning.transition?.weight, 0.5);
  const snapshot = instance.snapshot();
  const expected = instance.step(0.1);
  instance.restore(snapshot);
  assertEquals(instance.step(0.1), expected);
});

Deno.test("graph instances detach clip maps and reject corrupt snapshots atomically", () => {
  const skeleton = chain();
  const fixture = graph(clip());
  const clips = new Map(fixture.clips);
  const instance = new AnimationGraphInstance({
    graph: fixture.graph,
    skeleton,
    clips,
  });
  clips.clear();
  instance.step(0.1);
  const before = instance.snapshot();
  assertThrows(
    () => instance.restore({ ...before, state_time: Number.NaN }),
    Error,
    "state time NaN must be finite",
  );
  assertEquals(instance.snapshot(), before);
  instance.restore({ ...before, state_time: Number.MAX_VALUE });
  const maximum_time = instance.snapshot();
  assertThrows(
    () => instance.step(Number.MAX_VALUE),
    Error,
    "must be finite",
  );
  assertEquals(instance.snapshot(), maximum_time);
});

Deno.test("graph parsing rejects additive defaults outside the weight range", () => {
  const animation = clip();
  assertThrows(
    () =>
      create_graph({
        asset: graph_asset,
        initial: "active",
        parameters: { weight: 2 },
        states: [{
          id: "active",
          node: {
            type: "additive",
            base: { type: "clip", clip: animation.asset },
            layer: { type: "clip", clip: animation.asset },
            weight_parameter: "weight",
          },
        }],
        transitions: [],
      }, new Map([[animation.asset, animation]])),
    Error,
    "additive weight weight value 2 must be in 0..1",
  );
});

Deno.test("graph replacement uses new defaults when parameter types change", () => {
  const skeleton = chain();
  const fixture = graph(clip());
  const instance = new AnimationGraphInstance({
    graph: fixture.graph,
    skeleton,
    clips: fixture.clips,
  });
  instance.replace({
    asset: graph_asset,
    initial: " idle ",
    parameters: { moving: 3 },
    states: [{ id: " idle ", node: { type: "clip", clip: clip_asset } }],
    transitions: [],
  }, fixture.clips);
  assertEquals(instance.snapshot().parameters, { moving: 3 });
  assertEquals(instance.snapshot().state, "idle");
});

Deno.test("skin, rendering, and scene adapters preserve deterministic joint order", () => {
  const skeleton = chain();
  const fixture = graph(clip());
  const output = new AnimationGraphInstance({
    graph: fixture.graph,
    skeleton,
    clips: fixture.clips,
  }).step(0.1);
  assertEquals(skin_matrices(skeleton, output.pose).length, 3);
  assertEquals(rendering_output(skeleton, output).skin_matrices.length, 3);
  const writes = scene_transform_writes(skeleton, output.pose, [{
    joint: joint_id("knee"),
    node: scene_node_id(2, 0),
  }, { joint: joint_id("root"), node: scene_node_id(1, 0) }]);
  assertEquals(writes.map(({ node }) => node.index), [1, 2]);
  assertThrows(
    () => scene_transform_writes(skeleton, { transforms: [] }, []),
    Error,
    "scene animation skeleton hero.skeleton has 3 joints but pose has 0",
  );
});
