import {
  assertAlmostEquals,
  assertEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { scene_node_id } from "@ink/scene/identity.ts";
import {
  GpuOcclusionReadbacks,
  reversed_depth_pyramid,
} from "./experimental/occlusion.ts";
import {
  render_surface,
  render_surface_id,
  type RenderCapabilities,
  type RenderQualityProfile,
  select_quality_profile,
} from "./experimental/model.ts";
import { build_rendering_path } from "./experimental/paths.ts";
import {
  bloom_kernel,
  decode_pick,
  next_temporal_history,
  post_process_settings,
  screenshot,
  tone_map,
} from "./experimental/postprocess.ts";
import {
  pbr_shader_module,
  PipelineCache,
  validate_shader,
} from "./experimental/shader.ts";
import { visibility_id } from "@ink/visibility/model.ts";
import { vec3 } from "@ink/math/vector.ts";
import { mat4_identity } from "@ink/math/matrix.ts";
import { pack_deformation_upload } from "./experimental/extraction.ts";
import { RenderMetricHistory } from "./experimental/metrics.ts";
import { fsr2_jitter, plan_upscaling } from "./experimental/upscaling.ts";

const capabilities: RenderCapabilities = {
  adapter: "fixture",
  maximum_texture_dimension_2d: 8_192,
  maximum_buffer_bytes: 1_000_000,
  maximum_sample_count: 4,
  timestamp_queries: false,
  indirect_draw: true,
  depth_clip_control: true,
  supported_paths: new Set(["compatibility", "clustered_forward", "deferred"]),
};

function quality(path: RenderQualityProfile["path"]): RenderQualityProfile {
  return {
    path,
    hdr_format: "rgba16float",
    depth: "reversed",
    sample_count: 1,
    anti_aliasing: "taa",
    upscaling: { type: "native" },
    bloom: true,
    color_grading: true,
    maximum_lights: 256,
    maximum_shadow_lights: 8,
  };
}

Deno.test("quality selection degrades unsupported paths explicitly", () => {
  const selected = select_quality_profile(quality("deferred"), {
    ...capabilities,
    supported_paths: new Set(["compatibility"]),
  });
  assertEquals(selected.type, "ready");
  if (selected.type === "ready") {
    assertEquals([
      selected.profile.path,
      selected.degraded_from,
      selected.profile.anti_aliasing,
    ], ["compatibility", "deferred", "fxaa"]);
  }
});

Deno.test("all rendering paths preserve accepted object identity and final output", () => {
  const node = scene_node_id(3, 1);
  const lighting = { revision: 1 };
  const world = {
    scene_revision: 1,
    visible_revision: 1,
    material_revision: 1,
    light_revision: 1,
    transform_revision: 1,
    renderables: [{ node }],
    lighting,
  } as never;
  const packet = { object: node } as never;
  const surface = render_surface({
    id: render_surface_id("main"),
    width: 1280,
    height: 720,
    format: "bgra8unorm",
    revision: 0,
  });
  for (
    const path of ["compatibility", "clustered_forward", "deferred"] as const
  ) {
    const plan = build_rendering_path(quality(path), surface, world, [packet]);
    assertEquals(plan.object_id_by_draw, ["3:1"]);
    assertEquals(plan.graph.passes.at(-1)?.id, "tone_map");
    assertStrictEquals(plan.lighting, lighting);
  }
});

Deno.test("forward MSAA resolves its multisampled HDR attachment before post-processing", () => {
  const surface = render_surface({
    id: render_surface_id("msaa"),
    width: 64,
    height: 64,
    format: "bgra8unorm",
    revision: 0,
  });
  const world = {
    scene_revision: 0,
    visible_revision: 0,
    material_revision: 0,
    light_revision: 0,
    transform_revision: 0,
    renderables: [],
    lighting: {},
  } as never;
  const plan = build_rendering_path(
    { ...quality("clustered_forward"), sample_count: 4 },
    surface,
    world,
    [],
  );
  const forward = plan.graph.passes.find((pass) =>
    pass.id === "clustered_forward"
  );
  assertEquals(forward?.writes, [{
    resource: "hdr_msaa",
    access: "attachment",
    load: "clear",
    store: "discard",
    resolve: "hdr",
  }]);
});

Deno.test("FSR quality modes choose deterministic render extents and jitter", () => {
  const fsr1 = plan_upscaling({
    type: "fsr1",
    quality: "ultra_quality",
    sharpness: 0.2,
  }, { width: 1920, height: 1080 });
  assertEquals(fsr1.render_extent, { width: 1477, height: 831 });
  assertEquals(fsr1.temporal, false);

  const fsr2 = plan_upscaling({
    type: "fsr2",
    quality: "quality",
    sharpness: 0.1,
  }, { width: 1280, height: 720 });
  assertEquals(fsr2.render_extent, { width: 854, height: 480 });
  assertEquals(fsr2.temporal, true);
  const jitter = fsr2_jitter(0, fsr2);
  assertEquals(jitter.x, 0);
  assertAlmostEquals(jitter.y, -1 / 6);
  assertThrows(
    () =>
      plan_upscaling({
        type: "fsr2",
        quality: "unknown",
        sharpness: 0,
      } as never, { width: 1280, height: 720 }),
    Error,
    'render fsr2 quality "unknown"',
  );
});

Deno.test("FSR 1 upscales linear HDR with EASU and RCAS before tone mapping", () => {
  const surface = render_surface({
    id: render_surface_id("fsr1"),
    width: 1920,
    height: 1080,
    format: "bgra8unorm",
    revision: 0,
  });
  const world = {
    scene_revision: 0,
    visible_revision: 0,
    material_revision: 0,
    light_revision: 0,
    transform_revision: 0,
    renderables: [],
    lighting: {},
  } as never;
  const plan = build_rendering_path(
    {
      ...quality("clustered_forward"),
      anti_aliasing: "none",
      bloom: false,
      upscaling: { type: "fsr1", quality: "quality", sharpness: 0.2 },
    },
    surface,
    world,
    [],
  );
  const resources = new Map(
    plan.graph.resources.map((entry) => [entry.id, entry]),
  );
  assertEquals(resources.get("hdr")?.descriptor, {
    type: "texture",
    width: 1280,
    height: 720,
    depth_or_layers: 1,
    mip_levels: 1,
    sample_count: 1,
    format: "rgba16float",
    usage: 28,
  });
  assertEquals(resources.get("fsr1_output")?.descriptor, {
    type: "texture",
    width: 1920,
    height: 1080,
    depth_or_layers: 1,
    mip_levels: 1,
    sample_count: 1,
    format: "rgba16float",
    usage: 12,
  });
  assertEquals(
    plan.graph.passes.map((pass) => pass.id).slice(-3),
    ["fsr1_easu", "fsr1_rcas", "tone_map"],
  );
});

Deno.test("FSR 2 consumes motion and temporal history before HDR tone mapping", () => {
  const surface = render_surface({
    id: render_surface_id("fsr2"),
    width: 1920,
    height: 1080,
    format: "bgra8unorm",
    revision: 0,
  });
  const world = {
    scene_revision: 0,
    visible_revision: 0,
    material_revision: 0,
    light_revision: 0,
    transform_revision: 0,
    renderables: [],
    lighting: {},
  } as never;
  const plan = build_rendering_path(
    {
      ...quality("deferred"),
      anti_aliasing: "none",
      bloom: false,
      upscaling: { type: "fsr2", quality: "performance", sharpness: 0 },
    },
    surface,
    world,
    [],
  );
  assertEquals(plan.upscaling.render_extent, { width: 960, height: 540 });
  assertEquals(
    plan.graph.resources.find((resource) => resource.id === "motion_vectors")
      ?.descriptor,
    {
      type: "texture",
      width: 960,
      height: 540,
      depth_or_layers: 1,
      mip_levels: 1,
      sample_count: 1,
      format: "rg16float",
      usage: 20,
    },
  );
  const accumulate = plan.graph.passes.find((pass) =>
    pass.id === "fsr2_accumulate"
  );
  assertEquals(accumulate?.reads.map((read) => read.resource), [
    "hdr",
    "fsr2_reconstructed",
    "fsr2_depth_clip",
    "fsr2_locks",
    "fsr2_reactive_mask",
    "fsr2_color_history",
  ]);
  assertEquals(plan.graph.passes.at(-1)?.id, "tone_map");
});

Deno.test("FSR 2 rejects redundant temporal anti-aliasing and MSAA", () => {
  const fsr2 = {
    type: "fsr2" as const,
    quality: "quality" as const,
    sharpness: 0,
  };
  assertThrows(
    () =>
      select_quality_profile(
        { ...quality("deferred"), upscaling: fsr2 },
        capabilities,
      ),
    Error,
    'cannot be combined with "taa" anti-aliasing',
  );
  assertThrows(
    () =>
      select_quality_profile({
        ...quality("clustered_forward"),
        anti_aliasing: "none",
        sample_count: 4,
        upscaling: fsr2,
      }, capabilities),
    Error,
    "requires sample count 1",
  );
});

Deno.test("reversed depth pyramid reaches one texel with maximum reduction", () => {
  const levels = reversed_depth_pyramid(9, 5);
  assertEquals(levels.at(-1), {
    level: 4,
    width: 1,
    height: 1,
    reduction: "maximum",
  });
});

Deno.test("delayed occlusion results become stale or invalidate on camera cuts", () => {
  const id = visibility_id("object");
  const readbacks = new GpuOcclusionReadbacks({
    latency_frames: 2,
    maximum_pending: 2,
  });
  readbacks.submit(1, {
    input_revision: 4,
    object_ids: [id],
    visible_bits: new Uint32Array([0]),
  });
  assertEquals(readbacks.collect(2, 4), undefined);
  assertEquals(readbacks.collect(3, 5)?.get(id), {
    type: "stale",
    revision: 4,
    expected_revision: 5,
  });
  readbacks.submit(4, {
    input_revision: 6,
    object_ids: [id],
    visible_bits: new Uint32Array([1]),
  });
  assertEquals(readbacks.collect(6, 6, { camera_cut: true })?.get(id), {
    type: "invalidated",
    revision: 6,
    reason: "camera cut",
  });
});

Deno.test("tone mapping and bloom have stable CPU reference fixtures", () => {
  const settings = post_process_settings({
    exposure: 0,
    tone_mapping: "reinhard",
    bloom_threshold: 1,
    bloom_intensity: 0.2,
    debug_view: "final",
  });
  assertEquals(tone_map(vec3(1, 3, 0), settings), vec3(0.5, 0.75, 0));
  const kernel = bloom_kernel(2);
  assertAlmostEquals(kernel.reduce((sum, value) => sum + value, 0), 1, 1e-6);
});

Deno.test("temporal history resets on resize and picking retains draw identity", () => {
  const initial = next_temporal_history(undefined, {
    surface_revision: 0,
    frame: 0,
    color_revision: 0,
  });
  assertEquals(initial.reset_reason, "initial");
  const resized = next_temporal_history(initial, {
    surface_revision: 1,
    frame: 1,
    color_revision: 1,
  });
  assertEquals(resized.reset_reason, "resize");
  assertEquals(decode_pick(["object"], 0, 0.8), {
    type: "hit",
    object_id: "object",
    depth: 0.8,
  });
});

Deno.test("screenshots validate exact RGBA extent", () => {
  assertEquals(
    screenshot(1, 1, new Uint8Array([1, 2, 3, 4])).rgba8,
    new Uint8Array([1, 2, 3, 4]),
  );
  assertThrows(
    () => screenshot(2, 2, new Uint8Array(4)),
    Error,
    "needs 16 RGBA bytes",
  );
});

Deno.test("shader validation carries source entry evidence", () => {
  assertEquals(pbr_shader_module.id, "ink/pbr");
  assertThrows(
    () =>
      validate_shader({
        ...pbr_shader_module,
        id: "broken",
        source: "fn something_else() {}",
      }),
    Error,
    'entry point "vertex_main" is absent',
  );
});

Deno.test("shader validation canonicalizes reflection and rejects malformed bindings", () => {
  const shader = validate_shader({
    id: " custom ",
    revision: 0,
    source: "fn vertex_main() {}",
    reflection: {
      vertex_entry: " vertex_main ",
      bindings: [{
        group: 0,
        binding: 0,
        name: " camera ",
        kind: "uniform",
        visibility: ["vertex"],
      }],
    },
  });
  assertEquals(shader.reflection.vertex_entry, "vertex_main");
  assertEquals(shader.reflection.bindings[0].name, "camera");
  assertThrows(
    () =>
      validate_shader({
        ...shader,
        reflection: { ...shader.reflection, bindings: undefined as never },
      }),
    Error,
    "reflection bindings must be an array",
  );
});

Deno.test("pipeline cache evicts deterministically and counts misses", () => {
  const cache = new PipelineCache<string>(2);
  cache.acquire("a", 0, () => "a");
  cache.acquire("b", 0, () => "b");
  cache.acquire("c", 1, () => "c");
  assertEquals(cache.entries().map((entry) => entry.key), ["b", "c"]);
  assertEquals(cache.misses, 3);
});

Deno.test("animation deformation output packs matrices and stable morph ordering", () => {
  const upload = pack_deformation_upload(scene_node_id(1, 0), {
    skin_matrices: [mat4_identity()],
    morph_weights: new Map([["smile", 0.5], ["blink", 1]]),
  }, { skin_palette_revision: 2, morph_weights_revision: 3 });
  assertEquals(upload.skin_matrices.length, 16);
  assertEquals(upload.morph_names, ["blink", "smile"]);
  assertEquals(upload.morph_weights, new Float32Array([1, 0.5]));
});

Deno.test("render metrics retain a bounded frame history and pressure summary", () => {
  const history = new RenderMetricHistory(1);
  for (const frame of [0, 1]) {
    history.record({
      frame,
      extraction_seconds: 0.001,
      submission_seconds: 0.002,
      gpu_seconds: 0.003,
      allocated_bytes: 100 + frame,
      uploaded_bytes: 20,
      pipeline_misses: 1,
      shadow_cache_hits: 3,
      shadow_cache_misses: 1,
      visible_draws: 10,
      submitted_draws: 8,
      rejected_draws: 2,
      texture_bindings: 4,
    });
  }
  assertEquals(history.summary(), {
    frame_count: 1,
    mean_extraction_seconds: 0.001,
    mean_submission_seconds: 0.002,
    mean_gpu_seconds: 0.003,
    maximum_allocated_bytes: 101,
    uploaded_bytes: 20,
    pipeline_misses: 1,
    shadow_cache_hit_ratio: 0.75,
    rejected_draw_ratio: 0.2,
  });
});
