import { assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import { action_id } from "@ink/input/model.ts";
import type { InputFrame } from "@ink/input/model.ts";
import { recorded_frame_id } from "@ink/input/recording.ts";
import { mat4 } from "@ink/math/matrix.ts";
import { quat_identity } from "@ink/math/quaternion.ts";
import { vec2, vec3 } from "@ink/math/vector.ts";
import {
  apply_shake,
  update_first_person,
  update_follow,
  update_orbit,
  update_pan_zoom,
} from "./controllers.ts";
import {
  camera_id,
  type CameraDefinition,
  create_camera,
  create_camera_stack,
  resolve_viewport,
} from "./model.ts";
import {
  build_camera_frame,
  screen_ray,
  screen_to_world,
  world_to_screen,
} from "./view.ts";
import { adapt_xr_view_family } from "./xr.ts";

Deno.test("camera definitions reject invalid projections with camera evidence", () => {
  const camera = fixture_camera();
  assertEquals(
    create_camera({
      ...camera,
      projection: { ...camera.projection, near: 10, far: 1 },
    }),
    {
      type: "invalid_projection",
      camera: camera.id,
      field: "projection.far",
      value: 1,
      reason: "far plane must be finite and greater than near 10",
    },
  );
  assertEquals(
    create_camera({
      ...camera,
      projection: {
        type: "physical",
        sensor_height_millimeters: Number.MIN_VALUE,
        focal_length_millimeters: Number.MAX_VALUE,
        near: 0.1,
        far: 100,
        depth: "standard",
      },
    }).type,
    "invalid_projection",
  );
});

Deno.test("camera definitions snapshot authored values and reject incomplete viewports", () => {
  const definition = fixture_camera();
  const color = [0, 0, 0, 1] as [number, number, number, number];
  const viewport = { x: 0, y: 0, width: 1, height: 1 };
  const parsed = create_camera({
    ...definition,
    viewport,
    clear: { type: "color", color },
  });
  if (parsed.type !== "ready") throw new Error(parsed.reason);
  color[0] = 1;
  viewport.width = 0.5;
  assertEquals(parsed.camera.clear, { type: "color", color: [0, 0, 0, 1] });
  assertEquals(parsed.camera.viewport.width, 1);

  const incomplete = create_camera({
    ...definition,
    viewport: { x: 0, y: 0, width: 1 } as never,
  });
  assertEquals(incomplete.type, "invalid_projection");
  if (incomplete.type === "invalid_projection") {
    assertEquals(incomplete.field, "viewport.height");
  }
  const singular = create_camera({
    ...definition,
    projection: {
      type: "custom",
      matrix: mat4(new Array(16).fill(0)),
      near: 0.1,
      far: 100,
      depth: "standard",
    },
  });
  assertEquals(singular.type, "invalid_projection");
  if (singular.type === "invalid_projection") {
    assertEquals(
      singular.reason,
      "custom projection matrix is singular at pivot 0",
    );
  }
});

Deno.test("nested normalized viewports resolve inside their parent", () => {
  assertEquals(
    resolve_viewport(
      { x: 100, y: 50, width: 800, height: 600 },
      { x: 0.25, y: 0.5, width: 0.5, height: 0.25 },
    ),
    { x: 300, y: 350, width: 400, height: 150 },
  );
});

Deno.test("stable projection round trips world and screen coordinates", () => {
  const result = build_camera_frame({
    camera: fixture_camera(),
    surface: { width: 800, height: 600 },
    frame_index: 0,
  });
  if (result.type !== "ready") throw new Error(result.reason);
  const projected = world_to_screen(result.frame.view, vec3(0.5, -0.25, -5));
  if (projected.type !== "ready") throw new Error(projected.reason);
  const restored = screen_to_world(result.frame.view, projected.value);
  if (restored.type !== "ready") throw new Error(restored.reason);
  assertAlmostEquals(restored.value.x, 0.5, 1e-10);
  assertAlmostEquals(restored.value.y, -0.25, 1e-10);
  assertAlmostEquals(restored.value.z, -5, 1e-9);
});

Deno.test("screen rays agree with a forward perspective camera", () => {
  const result = build_camera_frame({
    camera: fixture_camera(),
    surface: { width: 800, height: 600 },
    frame_index: 0,
  });
  if (result.type !== "ready") throw new Error(result.reason);
  const cast = screen_ray(result.frame.view, 400, 300);
  if (cast.type !== "ready") throw new Error(cast.reason);
  assertAlmostEquals(cast.value.direction.x, 0, 1e-12);
  assertAlmostEquals(cast.value.direction.y, 0, 1e-12);
  assertAlmostEquals(cast.value.direction.z, -1, 1e-12);
  assertEquals(screen_ray(result.frame.view, Number.NaN, 0), {
    type: "conversion_failed",
    camera: camera_id("main"),
    operation: "screen ray",
    reason: "screen coordinates NaN,0 must be finite",
  });
});

Deno.test("camera frame construction returns typed failures for invalid request values", () => {
  assertEquals(
    build_camera_frame({
      camera: fixture_camera(),
      surface: { width: 0, height: 600 },
      frame_index: 0,
    }).type,
    "conversion_failed",
  );
  assertEquals(
    build_camera_frame({
      camera: fixture_camera(),
      surface: { width: 800, height: 600 },
      frame_index: 0,
      teleport_distance: Number.NaN,
    }).type,
    "conversion_failed",
  );
  assertEquals(
    build_camera_frame({
      camera: {
        ...fixture_camera(),
        projection: {
          type: "orthographic",
          vertical_size: Number.MAX_VALUE,
          near: 0.1,
          far: 100,
          depth: "standard",
        },
      },
      surface: { width: Number.MAX_SAFE_INTEGER, height: 1 },
      frame_index: 0,
    }).type,
    "conversion_failed",
  );
});

Deno.test("jitter never changes stable culling and cuts reset matrix history", () => {
  const first = ready_frame(build_camera_frame({
    camera: fixture_camera(),
    surface: { width: 800, height: 600 },
    frame_index: 0,
  }));
  const second = ready_frame(build_camera_frame({
    camera: fixture_camera(),
    surface: { width: 800, height: 600 },
    frame_index: 1,
    previous: first.history,
  }));
  assertEquals(
    second.view.stable_view_projection,
    first.view.stable_view_projection,
  );
  assertEquals(second.view.culling_frustum, first.view.culling_frustum);
  assertEquals(second.view.history_reset, undefined);
  assertEquals(
    second.view.previous_jittered_view_projection,
    first.view.jittered_view_projection,
  );

  const cut = ready_frame(build_camera_frame({
    camera: fixture_camera(),
    surface: { width: 800, height: 600 },
    frame_index: 2,
    previous: second.history,
    cut: true,
  }));
  assertEquals(cut.view.history_reset, "cut");
  assertEquals(
    cut.view.previous_jittered_view_projection,
    cut.view.jittered_view_projection,
  );
});

Deno.test("aspect changes reset history and rebuild perspective projection", () => {
  const first = ready_frame(build_camera_frame({
    camera: fixture_camera(),
    surface: { width: 800, height: 600 },
    frame_index: 0,
  }));
  const resized = ready_frame(build_camera_frame({
    camera: fixture_camera(),
    surface: { width: 1_200, height: 600 },
    frame_index: 1,
    previous: first.history,
  }));
  assertEquals(resized.view.history_reset, "resize");
  assertEquals(
    resized.view.stable_projection_matrix[0] <
      first.view.stable_projection_matrix[0],
    true,
  );
});

Deno.test("camera teleports reset temporal history", () => {
  const first = ready_frame(build_camera_frame({
    camera: fixture_camera(),
    surface: { width: 800, height: 600 },
    frame_index: 0,
  }));
  const teleported = ready_frame(build_camera_frame({
    camera: {
      ...fixture_camera(),
      pose: { ...fixture_camera().pose, position: vec3(100, 0, 0) },
    },
    surface: { width: 800, height: 600 },
    frame_index: 1,
    previous: first.history,
  }));
  assertEquals(teleported.view.history_reset, "teleport");
});

Deno.test("camera stacks sort by order and stable identity", () => {
  const first = fixture_camera("z");
  const second = { ...fixture_camera("a"), order: -1 };
  const stack = create_camera_stack([first, second]);
  if ("type" in stack) throw new Error(stack.reason);
  assertEquals(stack.cameras.map((camera) => camera.id), [second.id, first.id]);
});

Deno.test("first-person controllers consume named action snapshots purely", () => {
  const result = update_first_person(
    { position: vec3(0, 0, 0), yaw: 0, pitch: 0 },
    {
      move_action: "camera.move",
      look_action: "camera.look",
      move_speed: 2,
      look_speed: 1,
    },
    input_frame(),
    0.5,
  );
  assertEquals(result.state.position, vec3(1, 0, -1));
  assertEquals(result.state.yaw, 0);
  assertEquals(result.state.pitch, 0);
});

Deno.test("orbit controllers clamp zoom to their declared distance range", () => {
  const input = input_frame([{
    id: action_id("camera.zoom"),
    value: { type: "scalar", value: -100 },
    context: "camera",
  }]);
  const result = update_orbit(
    { target: vec3(0, 0, 0), distance: 5, yaw: 0, pitch: 0 },
    {
      orbit_action: "camera.orbit",
      zoom_action: "camera.zoom",
      orbit_speed: 1,
      zoom_speed: 1,
      minimum_distance: 2,
      maximum_distance: 10,
    },
    input,
    1,
  );
  assertEquals(result.state.distance, 2);
});

Deno.test("orthographic pan and zoom scale movement with view size", () => {
  const input = input_frame([
    {
      id: action_id("camera.pan"),
      value: { type: "axis2", value: vec2(1, -1) },
      context: "camera",
    },
    {
      id: action_id("camera.zoom"),
      value: { type: "scalar", value: 0 },
      context: "camera",
    },
  ]);
  assertEquals(
    update_pan_zoom(
      { center: vec3(0, 0, 0), vertical_size: 10 },
      {
        pan_action: "camera.pan",
        zoom_action: "camera.zoom",
        pan_speed: 0.5,
        zoom_speed: 1,
        minimum_size: 1,
        maximum_size: 20,
      },
      input,
      1,
    ),
    { center: vec3(5, -5, 0), vertical_size: 10 },
  );
  assertThrows(
    () =>
      update_pan_zoom(
        { center: vec3(0, 0, 0), vertical_size: 10 },
        {
          pan_action: "camera.pan",
          zoom_action: "camera.zoom",
          pan_speed: Number.NaN,
          zoom_speed: 1,
          minimum_size: 1,
          maximum_size: 20,
        },
        input,
        1,
      ),
    Error,
    "pan speed must be finite",
  );
});

Deno.test("follow controllers converge without overshooting", () => {
  const result = update_follow(
    { position: vec3(0, 0, 0) },
    vec3(10, 0, 0),
    2,
    0.5,
  );
  assertEquals(result.position.x > 0 && result.position.x < 10, true);
});

Deno.test("camera shake is deterministic for recorded state", () => {
  const pose = fixture_camera().pose;
  const state = {
    seed: 42,
    elapsed_seconds: 0,
    duration_seconds: 1,
    amplitude: 0.5,
    frequency: 10,
  };
  assertEquals(apply_shake(pose, state, 0.1), apply_shake(pose, state, 0.1));
});

Deno.test("XR adaptation is explicitly optional and returns independent views", () => {
  assertEquals(
    adapt_xr_view_family(
      undefined,
      fixture_camera(),
      { width: 1_000, height: 500 },
      0,
    ),
    { type: "unavailable", reason: "XR view capability is unavailable" },
  );
  let called = false;
  assertEquals(
    adapt_xr_view_family(
      {
        views() {
          called = true;
          return [];
        },
      },
      fixture_camera(),
      { width: 0, height: 500 },
      0,
    ).type,
    "failed",
  );
  assertEquals(called, false);
  assertEquals(
    adapt_xr_view_family(
      { views: () => [null] as never },
      fixture_camera(),
      { width: 1_000, height: 500 },
      0,
    ),
    { type: "failed", reason: "XR view 0 must be an object" },
  );
  const base_frame = ready_frame(build_camera_frame({
    camera: fixture_camera(),
    surface: { width: 1_000, height: 500 },
    frame_index: 0,
  }));
  const result = adapt_xr_view_family(
    {
      views() {
        return [
          {
            eye: "left",
            pose: fixture_camera().pose,
            projection_matrix: base_frame.view.stable_projection_matrix,
            viewport: { x: 0, y: 0, width: 0.5, height: 1 },
          },
          {
            eye: "right",
            pose: fixture_camera().pose,
            projection_matrix: base_frame.view.stable_projection_matrix,
            viewport: { x: 0.5, y: 0, width: 0.5, height: 1 },
          },
        ];
      },
    },
    fixture_camera(),
    { width: 1_000, height: 500 },
    0,
  );
  if (result.type !== "ready") throw new Error(result.reason);
  assertEquals(result.family.views.map((view) => view.viewport.width), [
    500,
    500,
  ]);
});

function fixture_camera(id = "main"): CameraDefinition {
  return {
    id: camera_id(id),
    pose: { position: vec3(0, 0, 0), rotation: quat_identity() },
    projection: {
      type: "perspective",
      vertical_fov_radians: Math.PI / 2,
      near: 0.1,
      far: 100,
      depth: "reversed",
    },
    viewport: { x: 0, y: 0, width: 1, height: 1 },
    layers: 0xffff_ffff,
    order: 0,
    clear: { type: "color", color: [0, 0, 0, 1] },
  };
}

function ready_frame(result: ReturnType<typeof build_camera_frame>) {
  if (result.type !== "ready") throw new Error(result.reason);
  return result.frame;
}

function input_frame(
  actions: InputFrame["actions"] = [
    {
      id: action_id("camera.move"),
      value: { type: "axis2", value: vec2(1, 1) },
      context: "camera",
    },
    {
      id: action_id("camera.look"),
      value: { type: "axis2", value: vec2(0, 0) },
      context: "camera",
    },
  ],
): InputFrame {
  return {
    frame_id: recorded_frame_id(0),
    actions,
    devices: {
      frame_id: recorded_frame_id(0),
      focused: true,
      controls: [],
      contacts: [],
      lifecycle: [],
    },
  };
}
