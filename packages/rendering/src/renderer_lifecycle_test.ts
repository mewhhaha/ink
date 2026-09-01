import {
  assertEquals,
  assertExists,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { create_path_tracing_compute } from "./path_tracing_gpu.ts";
import {
  create_renderer,
  perspective_render_camera,
  type RasterTemporalResetReason,
  render_color,
  render_material,
  render_mesh_id,
  render_node_id,
  render_scene_hierarchy,
  render_scene_node,
  render_technique,
  render_texture_id,
  type Renderer,
  type RenderFrameResult,
  type RenderScene,
  type RenderTechnique,
  type RenderTexture,
} from "./renderer.ts";
import {
  raster_post_shader,
  raster_scene_shader,
  raster_temporal_shader,
} from "./renderer_wgsl.ts";
import { format_shader_compilation_diagnostic } from "./shader_diagnostics.ts";

const raster: RenderTechnique = {
  type: "raster",
  path: "clustered_forward",
  sample_count: 1,
  anti_aliasing: "fxaa",
};
const path_traced: RenderTechnique = {
  type: "path_traced",
  samples_per_frame: 2,
  maximum_bounces: 4,
  render_scale: 1,
  denoiser: "edge_aware",
};

Deno.test("HDR output uses extended WebGPU presentation on an HDR display", async () => {
  const environment = install_webgpu({ hdr_display: true });
  try {
    const renderer = await create_renderer({
      canvas: environment.canvas,
      technique: raster,
    });
    assertEquals(renderer.hdr_output, { type: "available" });
    assertEquals(renderer.output_mode, "sdr");

    renderer.set_output_mode("hdr");
    renderer.render(scene());

    assertEquals(renderer.output_mode, "hdr");
    assertEquals(environment.context.tone_mapping_mode, "extended");
    assertEquals(environment.device.post_output_modes.at(-1), 1);
    renderer.set_output_mode("sdr");
    renderer.render(scene());
    assertEquals(environment.context.tone_mapping_mode, "standard");
    assertEquals(environment.device.post_output_modes.at(-1), 0);
    renderer.dispose();
  } finally {
    environment.restore();
  }
});

Deno.test("HDR output stays unavailable on an SDR display", async () => {
  const environment = install_webgpu();
  try {
    const renderer = await create_renderer({
      canvas: environment.canvas,
      technique: raster,
    });
    assertEquals(renderer.hdr_output, {
      type: "unavailable",
      reason: "The active display is not reporting HDR dynamic range.",
    });
    assertThrows(
      () => renderer.set_output_mode("hdr"),
      Error,
      "The active display is not reporting HDR dynamic range.",
    );
    assertEquals(renderer.output_mode, "sdr");
    renderer.dispose();
  } finally {
    environment.restore();
  }
});

Deno.test("renderer uploads AgX formation LUTs for SDR and HDR output", async () => {
  const environment = install_webgpu();
  try {
    const renderer = await create_renderer({
      canvas: environment.canvas,
      technique: raster,
    });

    assertEquals(
      environment.device.texture_upload_extents.filter(([width]) =>
        width === 29
      ),
      [[29, 29, 29], [29, 29, 29]],
    );
    renderer.dispose();
  } finally {
    environment.restore();
  }
});

Deno.test("renderer toggles one device between raster, path tracing, and camera-motion preview", async () => {
  const environment = install_webgpu();
  try {
    const renderer = await create_renderer({
      canvas: environment.canvas,
      technique: raster,
    });
    assertEquals(renderer.render(scene()).type, "raster");

    renderer.set_technique(path_traced);
    assertEquals(renderer.technique, path_traced);
    const submissions_before_path = environment.device.submissions;
    const compute_passes_before_path = environment.device.compute_passes;
    const render_passes_before_path = environment.device.render_passes;
    const initial = renderer.render(scene());
    assertEquals(initial, {
      type: "path_traced",
      acceleration: { type: "initialize" },
      accumulated_samples: 2,
      accumulation: "reset",
      cpu_oracle: { type: "miss" },
      reset_reasons: ["initial"],
    });
    assertEquals(
      environment.device.submissions - submissions_before_path,
      1,
    );
    assertEquals(
      environment.device.compute_passes - compute_passes_before_path,
      2,
    );
    assertEquals(
      environment.device.render_passes - render_passes_before_path,
      1,
    );
    const continued = renderer.render(scene());
    assertEquals(continued.type, "path_traced");
    if (continued.type === "path_traced") {
      assertEquals(continued.accumulated_samples, 4);
      assertEquals(continued.accumulation, "continued");
    }

    const moved = scene([1, 2, 5]);
    assertEquals(renderer.render(moved), {
      type: "raster",
      reason: "camera_motion",
      anti_aliasing: { type: "none" },
      visibility: { submitted: [], rejected: [] },
    });
    const resumed = renderer.render(moved);
    assertEquals(resumed.type, "path_traced");
    if (resumed.type === "path_traced") {
      assertEquals(resumed.accumulation, "reset");
      assertEquals(resumed.reset_reasons, ["initial"]);
    }

    renderer.set_technique({ ...raster, sample_count: 4 });
    assertEquals(renderer.render(moved), {
      type: "raster",
      reason: "requested",
      anti_aliasing: { type: "fxaa" },
      visibility: { submitted: [], rejected: [] },
    });
    assertEquals(environment.device.submissions > 0, true);
    renderer.dispose();
  } finally {
    environment.restore();
  }
});

Deno.test("raster anti-aliasing selects no filter, FXAA, and temporal accumulation distinctly", async () => {
  const environment = install_webgpu();
  try {
    const renderer = await create_renderer({
      canvas: environment.canvas,
      technique: { ...raster, anti_aliasing: "none" },
    });
    const unfiltered = renderer.render(scene());
    assertEquals(unfiltered.type, "raster");
    if (unfiltered.type === "raster") {
      assertEquals(unfiltered.anti_aliasing, { type: "none" });
    }
    assertEquals(environment.device.post_anti_aliasing_modes.at(-1), 0);

    renderer.set_technique({ ...raster, anti_aliasing: "fxaa" });
    const fxaa = renderer.render(scene());
    assertEquals(fxaa.type, "raster");
    if (fxaa.type === "raster") {
      assertEquals(fxaa.anti_aliasing, { type: "fxaa" });
    }
    assertEquals(environment.device.post_anti_aliasing_modes.at(-1), 1);

    renderer.set_technique({ ...raster, anti_aliasing: "taa" });
    const passes_before_taa = environment.device.render_passes;
    const temporal = renderer.render(scene());
    assertEquals(temporal.type, "raster");
    if (temporal.type === "raster") {
      assertEquals(temporal.anti_aliasing, {
        type: "taa",
        accumulation: "reset",
        reset_reasons: ["technique"],
      });
    }
    assertEquals(environment.device.render_passes - passes_before_taa, 4);
    renderer.dispose();
  } finally {
    environment.restore();
  }
});

Deno.test("temporal raster history resets for scene, camera, viewport, and technique changes", async () => {
  const environment = install_webgpu();
  try {
    const taa = { ...raster, anti_aliasing: "taa" } as const;
    const renderer = await create_renderer({
      canvas: environment.canvas,
      technique: taa,
    });
    assert_taa(renderer.render(scene()), "reset", ["initial"]);
    assert_taa(renderer.render(scene()), "continued", []);

    const changed_scene = {
      ...scene(),
      hierarchy: render_scene_hierarchy("fixture", 1, []),
    };
    assert_taa(renderer.render(changed_scene), "reset", ["scene"]);
    assert_taa(renderer.render(changed_scene), "continued", []);

    const moved = { ...changed_scene, camera: scene([1, 2, 5]).camera };
    assert_taa(renderer.render(moved), "reset", ["camera"]);
    assert_taa(renderer.render(moved), "continued", []);

    environment.resize(80, 60);
    assert_taa(renderer.render(moved), "reset", ["viewport"]);
    assert_taa(renderer.render(moved), "continued", []);

    renderer.set_technique({ ...raster, anti_aliasing: "none" });
    renderer.render(moved);
    renderer.set_technique(taa);
    assert_taa(renderer.render(moved), "reset", ["technique"]);
    renderer.dispose();
  } finally {
    environment.restore();
  }
});

Deno.test("fresh mesh arrays with identical bytes retain imported GPU buffers", async () => {
  const environment = install_webgpu();
  try {
    const renderer = await create_renderer({
      canvas: environment.canvas,
      technique: raster,
    });
    renderer.render(mesh_scene());
    const created_after_upload = environment.device.created_buffers;
    const destroyed_after_upload = environment.device.destroyed_buffers;

    renderer.render(mesh_scene());

    assertEquals(environment.device.created_buffers, created_after_upload);
    assertEquals(environment.device.destroyed_buffers, destroyed_after_upload);
    renderer.dispose();
  } finally {
    environment.restore();
  }
});

Deno.test("temporal raster history resets after same-sized mesh vertex and index byte edits", async () => {
  const environment = install_webgpu();
  try {
    const renderer = await create_renderer({
      canvas: environment.canvas,
      technique: { ...raster, anti_aliasing: "taa" },
    });
    const current = mesh_scene();
    assert_taa(renderer.render(current), "reset", ["initial"]);
    assert_taa(renderer.render(current), "continued", []);

    current.meshes[0].vertices[0] = -0.75;
    assert_taa(renderer.render(current), "reset", ["scene"]);
    assert_taa(renderer.render(current), "continued", []);

    current.meshes[0].indices.set([0, 2, 1]);
    assert_taa(renderer.render(current), "reset", ["scene"]);
    renderer.dispose();
  } finally {
    environment.restore();
  }
});

Deno.test("mesh revisions defer immutable geometry hashing and bounds until the revision changes", async () => {
  const environment = install_webgpu();
  try {
    const renderer = await create_renderer({
      canvas: environment.canvas,
      technique: raster,
    });
    const current = { ...mesh_scene(), mesh_revision: 0 };
    renderer.render(current);
    const created_after_upload = environment.device.created_buffers;

    for (const offset of [0, 8, 16]) {
      current.meshes[0].vertices[offset] += 100;
    }
    const unchanged = renderer.render(current);
    assertEquals(environment.device.created_buffers, created_after_upload);
    assertEquals(
      unchanged.type === "raster"
        ? unchanged.visibility.submitted.map(({ object_id }) => object_id)
        : [],
      ["fixture-triangle"],
    );

    const revised = renderer.render({ ...current, mesh_revision: 1 });
    assertEquals(
      environment.device.created_buffers,
      created_after_upload + 2,
    );
    assertEquals(
      revised.type === "raster"
        ? revised.visibility.rejected.map(({ object_id }) => object_id)
        : [],
      ["fixture-triangle"],
    );
    renderer.dispose();
  } finally {
    environment.restore();
  }
});

Deno.test("path-traced frames expose the packed CPU oracle object identity", async () => {
  const environment = install_webgpu();
  try {
    const renderer = await create_renderer({
      canvas: environment.canvas,
      technique: path_traced,
    });
    const rendered = renderer.render({
      ...scene(),
      hierarchy: render_scene_hierarchy("oracle", 0, [
        render_scene_node(0, {
          position: [0, 0, 0],
          rotation: { type: "y_axis", radians: 0 },
          scale: [1, 1, 1],
        }),
      ]),
      objects: [{
        id: "oracle-cube",
        shape: "cube",
        node: render_node_id(0),
        material: render_material("fixture/oracle", {
          albedo: [0.5, 0.5, 0.5],
          emissive: [0, 0, 0],
          metallic: 0,
          roughness: 0.5,
        }),
      }],
    });

    assertEquals(rendered.type, "path_traced");
    if (rendered.type === "path_traced") {
      assertEquals(rendered.cpu_oracle.type, "hit");
      if (rendered.cpu_oracle.type === "hit") {
        assertEquals(rendered.cpu_oracle.object_id, "oracle-cube");
      }
    }
    renderer.dispose();
  } finally {
    environment.restore();
  }
});

Deno.test("renderer falls back to raster after path initialization and execution failures", async () => {
  const initialization_failure = install_webgpu({
    fail_compute_pipeline: true,
  });
  try {
    const renderer = await create_renderer({
      canvas: initialization_failure.canvas,
      technique: path_traced,
    });
    const frame = renderer.render(scene());
    assertEquals(frame.type, "raster");
    if (frame.type === "raster") {
      assertEquals(frame.reason, "path_tracing_fallback");
      assertEquals(
        frame.path_tracing_failure?.includes("initialization failed"),
        true,
      );
    }
    assertEquals(renderer.status.type, "path_tracing_unavailable");
    renderer.dispose();
  } finally {
    initialization_failure.restore();
  }

  const execution_failure = install_webgpu();
  try {
    const renderer = await create_renderer({
      canvas: execution_failure.canvas,
      technique: path_traced,
    });
    execution_failure.device.fail_next_compute_pass = true;
    const frame = renderer.render(scene());
    assertEquals(frame.type, "raster");
    if (frame.type === "raster") {
      assertEquals(frame.reason, "path_tracing_fallback");
      assertEquals(
        frame.path_tracing_failure?.includes("execution failed"),
        true,
      );
    }
    assertEquals(renderer.status.type, "path_tracing_unavailable");
    renderer.dispose();
  } finally {
    execution_failure.restore();
  }
});

Deno.test("path compute initialization releases partial scene-buffer allocations", async () => {
  const device = new FakeGpuDevice({});
  device.fail_buffer_creation_after(3);

  await assertRejects(
    () => create_path_tracing_compute(device as unknown as GPUDevice),
    Error,
    "fixture buffer creation failure",
  );
  assertEquals(device.created_buffers > 0, true);
  assertEquals(device.destroyed_buffers, device.created_buffers);
  assertEquals(device.buffer_destroy_calls, device.created_buffers);
});

Deno.test("path compute initialization releases the first texture array when the second fails", async () => {
  const device = new FakeGpuDevice({});
  device.fail_texture_creation_after(1);

  await assertRejects(
    () => create_path_tracing_compute(device as unknown as GPUDevice),
    Error,
    "fixture texture creation failure",
  );
  assertEquals(device.created_buffers > 0, true);
  assertEquals(device.destroyed_buffers, device.created_buffers);
  assertEquals(device.buffer_destroy_calls, device.created_buffers);
  assertEquals(device.created_textures > 0, true);
  assertEquals(device.destroyed_textures, device.created_textures);
  assertEquals(device.texture_destroy_calls, device.created_textures);
});

Deno.test("failed scene-buffer replacement keeps the prior buffers alive", async () => {
  const environment = install_webgpu();
  try {
    const renderer = await create_renderer({
      canvas: environment.canvas,
      technique: raster,
    });
    renderer.render(scene());
    renderer.set_technique(path_traced);
    environment.device.fail_buffer_creation_after(2);
    const created_before = environment.device.created_buffers;
    const destroyed_before = environment.device.destroyed_buffers;
    const destroy_calls_before = environment.device.buffer_destroy_calls;

    const failed = renderer.render(scene());

    assertEquals(failed.type, "raster");
    if (failed.type === "raster") {
      assertEquals(failed.reason, "path_tracing_fallback");
    }
    assertEquals(environment.device.created_buffers - created_before, 2);
    assertEquals(environment.device.destroyed_buffers - destroyed_before, 2);
    assertEquals(
      environment.device.buffer_destroy_calls - destroy_calls_before,
      2,
    );
    renderer.set_technique(path_traced);
    assertEquals(renderer.render(scene()).type, "path_traced");
    renderer.dispose();
  } finally {
    environment.restore();
  }
});

Deno.test("failed target replacement keeps the prior accumulation targets alive", async () => {
  const environment = install_webgpu();
  try {
    const renderer = await create_renderer({
      canvas: environment.canvas,
      technique: path_traced,
    });
    assertEquals(renderer.render(scene()).type, "path_traced");
    const reduced = { ...path_traced, render_scale: 0.5 } as const;
    renderer.set_technique(reduced);
    environment.device.fail_texture_creation_after(2);
    const destroyed_before = environment.device.destroyed_textures;
    const destroy_calls_before = environment.device.texture_destroy_calls;

    const failed = renderer.render(scene());

    assertEquals(failed.type, "raster");
    if (failed.type === "raster") {
      assertEquals(failed.reason, "path_tracing_fallback");
    }
    assertEquals(environment.device.destroyed_textures - destroyed_before, 2);
    assertEquals(
      environment.device.texture_destroy_calls - destroy_calls_before,
      2,
    );
    renderer.set_technique(reduced);
    assertEquals(renderer.render(scene()).type, "path_traced");
    renderer.dispose();
  } finally {
    environment.restore();
  }
});

Deno.test("failed path texture upload destroys its replacement and retains the prior set", async () => {
  const environment = install_webgpu();
  try {
    const renderer = await create_renderer({
      canvas: environment.canvas,
      technique: path_traced,
    });
    assertEquals(renderer.render(scene()).type, "path_traced");
    environment.device.fail_external_image_copy_after(1);
    const destroyed_before = environment.device.destroyed_textures;
    const destroy_calls_before = environment.device.texture_destroy_calls;

    const failed = renderer.render(textured_scene(image_bitmap(4, 4)));

    assertEquals(failed.type, "raster");
    if (failed.type === "raster") {
      assertEquals(failed.reason, "path_tracing_fallback");
    }
    assertEquals(environment.device.destroyed_textures - destroyed_before, 1);
    assertEquals(
      environment.device.texture_destroy_calls - destroy_calls_before,
      1,
    );
    renderer.set_technique(path_traced);
    assertEquals(renderer.render(scene()).type, "path_traced");
    renderer.dispose();
  } finally {
    environment.restore();
  }
});

Deno.test("texture replacement preserves acceleration and restarts path accumulation", async () => {
  const environment = install_webgpu();
  try {
    const renderer = await create_renderer({
      canvas: environment.canvas,
      technique: path_traced,
    });
    const first_source = image_bitmap(4, 4);
    const first = renderer.render(textured_scene(first_source));
    assertEquals(first.type, "path_traced");
    assertEquals(environment.device.invalid_external_copy_destinations, 0);
    const continued = renderer.render(textured_scene(first_source));
    assertEquals(continued.type, "path_traced");
    if (continued.type === "path_traced") {
      assertEquals(continued.accumulation, "continued");
      assertEquals(continued.accumulated_samples, 4);
    }

    const copies_before_replacement = environment.device.external_image_copies;
    const replaced = renderer.render(textured_scene(image_bitmap(8, 8)));
    assertEquals(replaced.type, "path_traced");
    if (replaced.type === "path_traced") {
      assertEquals(replaced.acceleration, { type: "unchanged" });
      assertEquals(replaced.accumulation, "reset");
      assertEquals(replaced.reset_reasons, ["initial"]);
    }
    assertEquals(
      environment.device.external_image_copies > copies_before_replacement,
      true,
    );
    renderer.dispose();
  } finally {
    environment.restore();
  }
});

Deno.test("device loss releases the old resources and resumes on a replacement device", async () => {
  const environment = install_webgpu();
  try {
    const renderer = await create_renderer({
      canvas: environment.canvas,
      technique: path_traced,
    });
    renderer.render(scene());
    const lost_device = environment.device;
    lost_device.lose("fixture device removal");
    await wait_for_recovery(environment, renderer);

    assertEquals(renderer.status, { type: "ready" });
    assertEquals(lost_device.destroyed_resources > 0, true);
    assertEquals(environment.devices.length, 2);
    const recovered = renderer.render(scene());
    assertEquals(recovered.type, "path_traced");
    if (recovered.type === "path_traced") {
      assertEquals(recovered.acceleration, { type: "initialize" });
      assertEquals(recovered.accumulation, "reset");
      assertEquals(recovered.reset_reasons, ["initial"]);
    }
    assertEquals(environment.devices[1].submissions, 1);
    assertEquals(environment.context.configurations, 2);
    assertEquals(environment.adapter_requests, [
      { powerPreference: "high-performance", forceFallbackAdapter: false },
      { powerPreference: "high-performance", forceFallbackAdapter: false },
    ]);
    renderer.dispose();
  } finally {
    environment.restore();
  }
});

Deno.test("failed device recovery publishes the loss and keeps old resources released", async () => {
  const environment = install_webgpu({ fail_recovery_adapter: true });
  try {
    const renderer = await create_renderer({
      canvas: environment.canvas,
      technique: path_traced,
    });
    renderer.render(scene());
    const lost_device = environment.device;
    lost_device.lose("fixture adapter reset");
    await wait_for_renderer_status(renderer, "device_error");

    assertEquals(renderer.status, {
      type: "device_error",
      reason:
        "WebGPU device recovery failed after WebGPU device lost (unknown): fixture adapter reset: no WebGPU adapter is available",
    });
    assertEquals(lost_device.destroyed_resources > 0, true);
    assertEquals(environment.devices.length, 1);
    assertThrows(
      () => renderer.render(scene()),
      Error,
      "device recovery failed",
    );
    renderer.dispose();
  } finally {
    environment.restore();
  }
});

Deno.test("render techniques reject unbounded path workloads", () => {
  assertThrows(
    () => render_technique({ ...path_traced, samples_per_frame: 65 }),
    Error,
    "must be a safe integer within [1, 64]",
  );
  assertThrows(
    () => render_technique({ ...path_traced, maximum_bounces: 17 }),
    Error,
    "must be a safe integer within [1, 16]",
  );
  assertThrows(
    () => render_technique({ ...path_traced, render_scale: 0 }),
    Error,
    "must be within (0, 1]",
  );
});

Deno.test("render techniques reject raster paths without a stable implementation", () => {
  assertThrows(
    () => render_technique({ ...raster, path: "compatibility" } as never),
    Error,
    'raster path "compatibility" is unsupported; expected "clustered_forward"',
  );
  assertThrows(
    () => render_technique({ ...raster, path: "deferred" } as never),
    Error,
    'raster path "deferred" is unsupported; expected "clustered_forward"',
  );
});

Deno.test("shader diagnostics map generated WGSL lines back to their module", () => {
  const segment = raster_scene_shader.source_map.find(({ module }) =>
    module === "ink/rendering/raster-scene"
  );
  assertExists(segment);
  assertEquals(
    format_shader_compilation_diagnostic(raster_scene_shader, {
      lineNum: segment.generated_start_line + 4,
      linePos: 7,
      message: "fixture type mismatch",
    }),
    "ink/rendering/raster-scene 5:7: fixture type mismatch",
  );
});

Deno.test("shader diagnostics retain WebGPU errors without a source location", () => {
  assertEquals(
    format_shader_compilation_diagnostic(raster_scene_shader, {
      lineNum: 0,
      linePos: 0,
      message: "fixture pipeline failure",
    }),
    "generated WGSL 0:0: fixture pipeline failure",
  );
});

Deno.test("raster lighting composes the canonical PBR shader modules", () => {
  assertEquals(raster_scene_shader.modules.map(({ id }) => id), [
    "ink/brdf",
    "ink/pbr",
    "ink/rendering/raster-scene",
  ]);
});

Deno.test("raster post-processing composes distinct spatial and temporal shader modules", () => {
  assertEquals(raster_post_shader.modules.map(({ id }) => id), [
    "ink/rendering/raster-post",
  ]);
  assertEquals(raster_temporal_shader.modules.map(({ id }) => id), [
    "ink/rendering/raster-temporal",
  ]);
});

function assert_taa(
  frame: RenderFrameResult,
  accumulation: "reset" | "continued",
  reset_reasons: readonly RasterTemporalResetReason[],
): void {
  assertEquals(frame.type, "raster");
  if (frame.type !== "raster") return;
  assertEquals(frame.anti_aliasing, {
    type: "taa",
    accumulation,
    reset_reasons,
  });
}

async function wait_for_recovery(
  environment: ReturnType<typeof install_webgpu>,
  renderer: Renderer,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (environment.devices.length === 2 && renderer.status.type === "ready") {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(
    `renderer did not recover: ${
      JSON.stringify({
        devices: environment.devices.length,
        status: renderer.status,
      })
    }`,
  );
}

async function wait_for_renderer_status(
  renderer: Renderer,
  expected: Renderer["status"]["type"],
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (renderer.status.type === expected) return;
    await Promise.resolve();
  }
  throw new Error(
    `renderer status did not become ${expected}: ${
      JSON.stringify(renderer.status)
    }`,
  );
}

function scene(
  position: readonly [number, number, number] = [0, 2, 5],
): RenderScene {
  return {
    camera: perspective_render_camera("fixture.camera", {
      position,
      target: [0, 0, 0],
      vertical_fov_radians: 1,
      clear_color: [0.01, 0.02, 0.03],
    }),
    hierarchy: render_scene_hierarchy("fixture", 0, []),
    lights: [],
    environment: {
      ambient_light: render_color([0.1, 0.1, 0.1]),
      fog_color: render_color([0, 0, 0]),
      fog_density: 0,
      exposure_ev100: 0,
      bloom_intensity: 0,
    },
    meshes: [],
    textures: [],
    objects: [],
  };
}

function textured_scene(source: ImageBitmap): RenderScene {
  const texture_id = render_texture_id("fixture/surface");
  const texture: RenderTexture = {
    color_space: "srgb",
    id: texture_id,
    source,
  };
  return {
    ...scene(),
    hierarchy: render_scene_hierarchy("fixture-textured", 0, [
      render_scene_node(0, {
        position: [0, 0, 0],
        rotation: { type: "y_axis", radians: 0 },
        scale: [1, 1, 1],
      }),
    ]),
    textures: [texture],
    objects: [{
      id: "textured-plane",
      shape: "plane",
      node: render_node_id(0),
      material: render_material("fixture/textured", {
        albedo: [1, 1, 1],
        base_color_texture: texture_id,
        emissive: [0, 0, 0],
        metallic: 0,
        roughness: 0.5,
      }),
    }],
  };
}

function mesh_scene(): RenderScene {
  const mesh_id = render_mesh_id("fixture/triangle");
  return {
    ...scene(),
    hierarchy: render_scene_hierarchy("fixture-mesh", 0, [
      render_scene_node(0, {
        position: [0, 0, 0],
        rotation: { type: "y_axis", radians: 0 },
        scale: [1, 1, 1],
      }),
    ]),
    meshes: [{
      id: mesh_id,
      vertices: new Float32Array([
        -1,
        -1,
        0,
        0,
        0,
        1,
        0,
        0,
        1,
        -1,
        0,
        0,
        0,
        1,
        1,
        0,
        0,
        1,
        0,
        0,
        0,
        1,
        0.5,
        1,
      ]),
      indices: new Uint32Array([0, 1, 2]),
    }],
    objects: [{
      id: "fixture-triangle",
      shape: "mesh",
      mesh: mesh_id,
      node: render_node_id(0),
      material: render_material("fixture/triangle", {
        albedo: [0.5, 0.5, 0.5],
        emissive: [0, 0, 0],
        metallic: 0,
        roughness: 0.5,
      }),
    }],
  };
}

function image_bitmap(width: number, height: number): ImageBitmap {
  return { width, height } as ImageBitmap;
}

interface FakeWebGpuOptions {
  readonly fail_compute_pipeline?: boolean;
  readonly fail_recovery_adapter?: boolean;
  readonly hdr_display?: boolean;
}

function install_webgpu(options: FakeWebGpuOptions = {}) {
  const previous = Object.getOwnPropertyDescriptor(navigator, "gpu");
  const previous_match_media = Object.getOwnPropertyDescriptor(
    globalThis,
    "matchMedia",
  );
  const devices: FakeGpuDevice[] = [];
  const context = new FakeCanvasContext();
  const adapter_requests: GPURequestAdapterOptions[] = [];
  const canvas = {
    clientWidth: 64,
    clientHeight: 48,
    width: 64,
    height: 48,
    getContext: (name: string) => name === "webgpu" ? context : null,
  } as unknown as HTMLCanvasElement;
  Object.defineProperty(navigator, "gpu", {
    configurable: true,
    value: {
      getPreferredCanvasFormat: () => "bgra8unorm",
      requestAdapter: (request: GPURequestAdapterOptions) => {
        adapter_requests.push(request);
        if (options.fail_recovery_adapter && adapter_requests.length > 1) {
          return Promise.resolve(null);
        }
        return Promise.resolve({
          info: {
            description: "fixture adapter",
            vendor: "fixture",
            isFallbackAdapter: false,
          },
          requestDevice: () => {
            const device = new FakeGpuDevice(options);
            devices.push(device);
            return Promise.resolve(device as unknown as GPUDevice);
          },
        });
      },
    },
  });
  Object.defineProperty(globalThis, "matchMedia", {
    configurable: true,
    value: (query: string) =>
      ({
        matches: query === "(dynamic-range: high)" &&
          options.hdr_display === true,
        media: query,
      }) as MediaQueryList,
  });
  return {
    canvas,
    adapter_requests,
    context,
    devices,
    get device() {
      const device = devices[0];
      if (device === undefined) {
        throw new Error("fixture renderer has not requested a WebGPU device");
      }
      return device;
    },
    resize(width: number, height: number) {
      Object.assign(canvas, { clientWidth: width, clientHeight: height });
    },
    restore() {
      if (previous === undefined) delete (navigator as { gpu?: unknown }).gpu;
      else Object.defineProperty(navigator, "gpu", previous);
      if (previous_match_media === undefined) {
        delete (globalThis as { matchMedia?: unknown }).matchMedia;
      } else {
        Object.defineProperty(globalThis, "matchMedia", previous_match_media);
      }
    },
  };
}

class FakeGpuDevice {
  readonly queue = {
    copyExternalImageToTexture: (
      _source: unknown,
      destination: { readonly texture: GPUTexture },
    ) => {
      this.#external_image_copy_attempts += 1;
      if (
        this.#external_image_copy_attempts ===
          this.#external_image_copy_failure_at
      ) {
        this.#external_image_copy_failure_at = undefined;
        throw new Error("fixture external image copy failure");
      }
      this.external_image_copies += 1;
      const texture = destination.texture as unknown as FakeGpuTexture;
      if ((texture.usage & 0x10) === 0) {
        this.invalid_external_copy_destinations += 1;
      }
    },
    submit: () => {
      this.submissions += 1;
    },
    writeBuffer: (
      _buffer: GPUBuffer,
      _offset: number,
      values: AllowSharedBufferSource,
    ) => {
      if (!(values instanceof Float32Array) || values.length !== 8) return;
      this.post_output_modes.push(values[2]);
      this.post_anti_aliasing_modes.push(values[6]);
    },
    writeTexture: (
      _destination: GPUTexelCopyTextureInfo,
      _bytes: AllowSharedBufferSource,
      _layout: GPUTexelCopyBufferLayout,
      extent: GPUExtent3D,
    ) => {
      if (!Array.isArray(extent)) return;
      this.texture_upload_extents.push([
        Number(extent[0]),
        Number(extent[1] ?? 1),
        Number(extent[2] ?? 1),
      ]);
    },
  };
  readonly lost: Promise<GPUDeviceLostInfo>;
  buffer_destroy_calls = 0;
  created_buffers = 0;
  created_textures = 0;
  destroyed_buffers = 0;
  destroyed_resources = 0;
  destroyed_textures = 0;
  external_image_copies = 0;
  invalid_external_copy_destinations = 0;
  post_anti_aliasing_modes: number[] = [];
  post_output_modes: number[] = [];
  compute_passes = 0;
  fail_next_compute_pass = false;
  render_passes = 0;
  submissions = 0;
  texture_upload_extents: number[][] = [];
  texture_destroy_calls = 0;
  #buffer_creation_attempts = 0;
  #buffer_creation_failure_at: number | undefined;
  #external_image_copy_attempts = 0;
  #external_image_copy_failure_at: number | undefined;
  #resolve_loss!: (value: GPUDeviceLostInfo) => void;
  #fail_compute_pipeline: boolean;
  #texture_creation_attempts = 0;
  #texture_creation_failure_at: number | undefined;

  constructor(options: FakeWebGpuOptions) {
    this.#fail_compute_pipeline = options.fail_compute_pipeline ?? false;
    this.lost = new Promise((resolve) => {
      this.#resolve_loss = resolve;
    });
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  destroy(): void {}
  pushErrorScope(): void {}
  popErrorScope(): Promise<GPUError | null> {
    return Promise.resolve(null);
  }
  createShaderModule() {
    return {
      getCompilationInfo: () => Promise.resolve({ messages: [] }),
    } as unknown as GPUShaderModule;
  }
  createRenderPipelineAsync() {
    return Promise.resolve(fake_pipeline());
  }
  createComputePipelineAsync() {
    if (this.#fail_compute_pipeline) {
      return Promise.reject(new Error("fixture compute pipeline rejection"));
    }
    return Promise.resolve(fake_pipeline() as unknown as GPUComputePipeline);
  }
  createBuffer(descriptor: GPUBufferDescriptor) {
    this.#buffer_creation_attempts += 1;
    if (this.#buffer_creation_attempts === this.#buffer_creation_failure_at) {
      this.#buffer_creation_failure_at = undefined;
      throw new Error("fixture buffer creation failure");
    }
    this.created_buffers += 1;
    return new FakeGpuBuffer(
      Number(descriptor.size),
      (first) => {
        this.buffer_destroy_calls += 1;
        if (!first) return;
        this.destroyed_buffers += 1;
        this.destroyed_resources += 1;
      },
    ) as unknown as GPUBuffer;
  }
  createTexture(descriptor: GPUTextureDescriptor) {
    this.#texture_creation_attempts += 1;
    if (
      this.#texture_creation_attempts === this.#texture_creation_failure_at
    ) {
      this.#texture_creation_failure_at = undefined;
      throw new Error("fixture texture creation failure");
    }
    this.created_textures += 1;
    return new FakeGpuTexture(
      (first) => {
        this.texture_destroy_calls += 1;
        if (!first) return;
        this.destroyed_textures += 1;
        this.destroyed_resources += 1;
      },
      descriptor.usage,
    ) as unknown as GPUTexture;
  }
  createSampler() {
    return {} as GPUSampler;
  }
  createBindGroup() {
    return {} as GPUBindGroup;
  }
  createCommandEncoder() {
    return new FakeCommandEncoder(this) as unknown as GPUCommandEncoder;
  }
  fail_buffer_creation_after(successful_creations: number): void {
    this.#buffer_creation_failure_at = this.#buffer_creation_attempts +
      successful_creations + 1;
  }
  fail_external_image_copy_after(successful_copies: number): void {
    this.#external_image_copy_failure_at = this.#external_image_copy_attempts +
      successful_copies + 1;
  }
  fail_texture_creation_after(successful_creations: number): void {
    this.#texture_creation_failure_at = this.#texture_creation_attempts +
      successful_creations + 1;
  }
  lose(message: string): void {
    this.#resolve_loss({ message, reason: "unknown" });
  }
}

class FakeGpuBuffer {
  readonly #bytes: ArrayBuffer;
  readonly #destroy: (first: boolean) => void;
  #destroyed = false;

  constructor(size: number, destroy: (first: boolean) => void) {
    this.#bytes = new ArrayBuffer(size);
    this.#destroy = destroy;
  }

  getMappedRange(): ArrayBuffer {
    return this.#bytes;
  }
  unmap(): void {}
  destroy(): void {
    const first = !this.#destroyed;
    this.#destroyed = true;
    this.#destroy(first);
  }
}

class FakeGpuTexture {
  readonly #destroy: (first: boolean) => void;
  readonly usage: GPUTextureUsageFlags;
  #destroyed = false;

  constructor(destroy: (first: boolean) => void, usage = 0) {
    this.#destroy = destroy;
    this.usage = usage;
  }

  createView() {
    return {} as GPUTextureView;
  }
  destroy(): void {
    const first = !this.#destroyed;
    this.#destroyed = true;
    this.#destroy(first);
  }
}

class FakeCommandEncoder {
  readonly #device: FakeGpuDevice;

  constructor(device: FakeGpuDevice) {
    this.#device = device;
  }

  beginRenderPass() {
    this.#device.render_passes += 1;
    return fake_render_pass();
  }
  beginComputePass() {
    if (this.#device.fail_next_compute_pass) {
      this.#device.fail_next_compute_pass = false;
      throw new Error("fixture compute encoding rejection");
    }
    this.#device.compute_passes += 1;
    return {
      dispatchWorkgroups: () => undefined,
      end: () => undefined,
      setBindGroup: () => undefined,
      setPipeline: () => undefined,
    } as unknown as GPUComputePassEncoder;
  }
  finish() {
    return {} as GPUCommandBuffer;
  }
}

class FakeCanvasContext {
  configurations = 0;
  unconfigurations = 0;
  tone_mapping_mode: string | undefined;
  #configuration: GPUCanvasConfiguration | undefined;
  #device: FakeGpuDevice | undefined;

  configure(configuration: GPUCanvasConfiguration): void {
    if (!(configuration.device instanceof FakeGpuDevice)) {
      throw new Error("fixture canvas received an unknown WebGPU device");
    }
    this.configurations += 1;
    this.#configuration = configuration;
    this.tone_mapping_mode = (configuration as GPUCanvasConfiguration & {
      toneMapping?: { readonly mode?: string };
    }).toneMapping?.mode;
    this.#device = configuration.device;
  }
  getConfiguration(): GPUCanvasConfiguration | null {
    return this.#configuration ?? null;
  }
  unconfigure(): void {
    this.unconfigurations += 1;
    this.#configuration = undefined;
    this.#device = undefined;
  }
  getCurrentTexture() {
    const device = this.#device;
    if (device === undefined) {
      throw new Error("fixture canvas context is not configured");
    }
    return new FakeGpuTexture(
      (first) => {
        device.texture_destroy_calls += 1;
        if (!first) return;
        device.destroyed_textures += 1;
        device.destroyed_resources += 1;
      },
    ) as unknown as GPUTexture;
  }
}

function fake_pipeline(): GPURenderPipeline {
  return {
    getBindGroupLayout: () => ({} as GPUBindGroupLayout),
  } as unknown as GPURenderPipeline;
}

function fake_render_pass(): GPURenderPassEncoder {
  return {
    draw: () => undefined,
    drawIndexed: () => undefined,
    end: () => undefined,
    setBindGroup: () => undefined,
    setIndexBuffer: () => undefined,
    setPipeline: () => undefined,
    setVertexBuffer: () => undefined,
  } as unknown as GPURenderPassEncoder;
}
