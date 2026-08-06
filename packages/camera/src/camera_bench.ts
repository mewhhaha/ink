import { quat_identity } from "@ink/math/quaternion.ts";
import { vec3 } from "@ink/math/vector.ts";
import { camera_id, type CameraDefinition } from "./model.ts";
import { build_camera_frame, screen_ray } from "./view.ts";

const camera: CameraDefinition = {
  id: camera_id("benchmark"),
  pose: { position: vec3(0, 0, 0), rotation: quat_identity() },
  projection: {
    type: "perspective",
    vertical_fov_radians: Math.PI / 3,
    near: 0.1,
    far: 10_000,
    depth: "reversed",
  },
  viewport: { x: 0, y: 0, width: 1, height: 1 },
  layers: 0xffff_ffff,
  order: 0,
  clear: { type: "color", color: [0, 0, 0, 1] },
};

Deno.bench("build 1,000 jittered camera views", () => {
  let history;
  for (let index = 0; index < 1_000; index += 1) {
    const result = build_camera_frame({
      camera,
      surface: { width: 1920, height: 1080 },
      frame_index: index,
      previous: history,
    });
    if (result.type !== "ready") throw new Error(result.reason);
    history = result.frame.history;
  }
});

const frame = build_camera_frame({
  camera,
  surface: { width: 1920, height: 1080 },
  frame_index: 0,
});
if (frame.type !== "ready") throw new Error(frame.reason);

Deno.bench("construct 10,000 screen rays", () => {
  for (let index = 0; index < 10_000; index += 1) {
    const result = screen_ray(frame.frame.view, index % 1920, index % 1080);
    if (result.type !== "ready") throw new Error(result.reason);
  }
});
