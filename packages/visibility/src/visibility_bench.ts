import { build_camera_frame } from "@ink/camera/view.ts";
import { camera_id, type CameraDefinition } from "@ink/camera/model.ts";
import { aabb } from "@ink/geometry/shapes.ts";
import { quat_identity } from "@ink/math/quaternion.ts";
import { vec3 } from "@ink/math/vector.ts";
import { visibility_id, visibility_object } from "./model.ts";
import { VisibilityPipeline } from "./pipeline.ts";

const camera: CameraDefinition = {
  id: camera_id("benchmark"),
  pose: { position: vec3(0, 0, 0), rotation: quat_identity() },
  projection: {
    type: "perspective",
    vertical_fov_radians: Math.PI / 2,
    near: 0.1,
    far: 10_000,
    depth: "reversed",
  },
  viewport: { x: 0, y: 0, width: 1, height: 1 },
  layers: 1,
  order: 0,
  clear: { type: "load" },
};
const frame = build_camera_frame({
  camera,
  surface: { width: 1920, height: 1080 },
  frame_index: 0,
});
if (frame.type !== "ready") throw new Error(frame.reason);
const pipeline = new VisibilityPipeline();
const policy = {
  lod_hysteresis_ratio: 0.1,
  motion_expansion_seconds: 0.1,
  maximum_portal_depth: 16,
};

for (
  const [name, count, spacing, moving] of [
    ["sparse", 1_000, 20, false],
    ["dense", 10_000, 1, false],
    ["indoor", 5_000, 2, false],
    ["terrain", 8_000, 8, false],
    ["high-motion", 5_000, 2, true],
  ] as const
) {
  const objects = Array.from({ length: count }, (_, index) => {
    const x = (index % 100 - 50) * spacing;
    const y = (Math.floor(index / 100) % 20 - 10) * spacing;
    const z = -10 - Math.floor(index / 2_000) * spacing;
    return visibility_object({
      id: visibility_id(`${name}/${index}`),
      bounds: aabb(
        vec3(x - 0.5, y - 0.5, z - 0.5),
        vec3(x + 0.5, y + 0.5, z + 0.5),
      ),
      layers: 1,
      revision: 1,
      lods: [{ id: "default", minimum_projected_pixels: 0 }],
      occluder: false,
      ...(moving ? { velocity: vec3(10, 0, 0) } : {}),
    });
  });
  Deno.bench(`visibility ${name} fixture`, () => {
    const result = pipeline.evaluate(objects, {
      revision: 1,
      views: [frame.frame.view],
      policy,
    });
    if (result.visible.length + result.rejected.length !== objects.length) {
      throw new Error(`${name} visibility benchmark lost objects`);
    }
  });
}
