import { asset_id, type AssetId } from "@ink/assets/identity.ts";
import { camera_id, type CameraDefinition } from "@ink/camera/model.ts";
import {
  build_camera_frame,
  type CameraFrame,
  type CameraHistory,
  type CameraView,
  screen_ray,
} from "@ink/camera/view.ts";
import { create_light } from "@ink/lighting/light.ts";
import { light_id } from "@ink/lighting/identity.ts";
import type { LightDefinition } from "@ink/lighting/light.ts";
import {
  canonical_material_record,
  create_material_definition,
  default_pbr_parameters,
} from "@ink/materials/canonical.ts";
import {
  linear_rgb,
  linear_rgba,
  type LinearRgb,
} from "@ink/materials/color.ts";
import { material_definition_id } from "@ink/materials/identity.ts";
import type { CanonicalMaterialRecord } from "@ink/materials/canonical.ts";
import {
  texture_binding,
  type TextureBinding,
} from "@ink/materials/texture.ts";
import {
  type Mat4,
  mat4_inverse,
  mat4_multiply,
  mat4_transform_affine_point,
  mat4_transform_direction,
} from "@ink/math/matrix.ts";
import { look_at_view, orthographic_projection } from "@ink/math/projection.ts";
import {
  quat_from_axis_angle,
  quat_multiply,
  quat_rotate_vec3,
} from "@ink/math/quaternion.ts";
import { transform } from "@ink/math/transform.ts";
import {
  type Vec3,
  vec3,
  vec3_add,
  vec3_cross,
  vec3_dot,
  vec3_length,
  vec3_normalize,
  vec3_scale,
  vec3_subtract,
} from "@ink/math/vector.ts";
import { trace_ray } from "@ink/ray-tracing/trace.ts";
import { type Aabb, aabb, aabb_from_points } from "@ink/geometry/shapes.ts";
import {
  resolve_scene,
  type SceneNodeSource,
  type SceneSource,
} from "@ink/scene/hierarchy.ts";
import {
  scene_id,
  scene_node_id,
  scene_node_key,
  type SceneNodeId,
} from "@ink/scene/identity.ts";
import {
  type RejectionReason,
  visibility_id,
  visibility_object,
  type VisibilityId,
  type VisibleSet,
} from "@ink/visibility/model.ts";
import { VisibilityPipeline } from "@ink/visibility/pipeline.ts";
import {
  raster_mipmap_shader,
  raster_post_shader,
  raster_scene_shader,
  raster_shadow_shader,
  raster_temporal_shader,
} from "./renderer_wgsl.ts";
import {
  path_tracing_render_scene_snapshot,
  type PathTracingFrameHistory,
  type PathTracingRenderSceneSnapshot,
  plan_path_tracing_frame,
  type RendererAccelerationUpdate,
} from "./path_tracing.ts";
import {
  create_path_tracing_compute,
  type PathTracingCompute,
} from "./path_tracing_gpu.ts";
import {
  AGX_HDR_LUT_BASE64,
  AGX_LUT_SIZE,
  AGX_SDR_LUT_BASE64,
} from "./agx_luts_generated.ts";
import { format_shader_compilation_diagnostic } from "./shader_diagnostics.ts";

export type RenderVector = readonly [number, number, number];
export type RenderCamera = CameraDefinition;
export type BuiltInGeometry = "cube" | "plane" | "sphere";
export type RenderMeshId = AssetId<"mesh">;
export type RenderTextureId = AssetId<"texture">;

export interface RenderMaterialInput {
  readonly albedo: RenderVector;
  readonly base_color_texture?: RenderTextureId;
  readonly emissive: RenderVector;
  readonly metallic: number;
  readonly normal_texture?: RenderTextureId;
  readonly roughness: number;
}

interface RenderObjectProperties {
  readonly id: string;
  readonly node: SceneNodeId;
  readonly material: CanonicalMaterialRecord;
  readonly raster_visibility?: RenderObjectVisibility;
}

export type RenderGeometry =
  | { readonly shape: BuiltInGeometry }
  | { readonly shape: "mesh"; readonly mesh: RenderMeshId };

export interface RenderObjectLod {
  readonly id: string;
  readonly minimum_projected_pixels: number;
  readonly geometry: RenderGeometry;
}

export interface RenderObjectVisibility {
  readonly id: VisibilityId;
  readonly minimum_projected_pixels?: number;
  readonly maximum_distance?: number;
  readonly lods?: readonly RenderObjectLod[];
}

export type RenderObject = RenderObjectProperties & RenderGeometry;

export interface RenderMesh {
  readonly id: RenderMeshId;
  readonly indices: Uint32Array;
  readonly vertices: Float32Array;
}

export interface RenderMeshMetadata {
  readonly bounds: ReadonlyMap<RenderMeshId, Aabb>;
  readonly content_key: string;
}

export interface RenderTexture {
  readonly color_space: "linear" | "srgb";
  readonly id: RenderTextureId;
  readonly source: ImageBitmap;
}

export interface RenderEnvironment {
  readonly ambient_light: LinearRgb;
  readonly fog_color: LinearRgb;
  readonly fog_density: number;
  readonly exposure_ev100: number;
  readonly bloom_intensity: number;
}

export interface RenderScene {
  readonly camera: CameraDefinition;
  readonly hierarchy: SceneSource;
  readonly lights: readonly LightDefinition[];
  readonly environment: RenderEnvironment;
  readonly meshes: readonly RenderMesh[];
  readonly mesh_metadata?: RenderMeshMetadata;
  readonly mesh_revision?: number;
  readonly textures: readonly RenderTexture[];
  readonly objects: readonly RenderObject[];
}

export type RenderTechnique =
  | {
    readonly type: "raster";
    readonly path: "clustered_forward";
    readonly sample_count: 1 | 4;
    readonly anti_aliasing: "none" | "fxaa" | "taa";
  }
  | {
    readonly type: "path_traced";
    readonly samples_per_frame: number;
    readonly maximum_bounces: number;
    readonly render_scale: number;
    readonly denoiser: "edge_aware";
  };

export type RasterTechnique = Extract<
  RenderTechnique,
  { readonly type: "raster" }
>;
export type PathTracedTechnique = Extract<
  RenderTechnique,
  { readonly type: "path_traced" }
>;

export interface RendererOptions {
  readonly canvas: HTMLCanvasElement;
  readonly technique: RenderTechnique;
}

export type RenderOutputMode = "sdr" | "hdr";

export type HdrOutputAvailability =
  | { readonly type: "available" }
  | { readonly type: "unavailable"; readonly reason: string };

export interface Renderer {
  readonly adapter_description: string;
  readonly hdr_output: HdrOutputAvailability;
  readonly output_mode: RenderOutputMode;
  readonly status: RendererStatus;
  readonly technique: RenderTechnique;
  readonly validation_error_count: number;
  pick(scene: RenderScene, point: RenderPickPoint): RenderPickResult;
  render(scene: RenderScene): RenderFrameResult;
  set_output_mode(output_mode: RenderOutputMode): void;
  set_technique(technique: RenderTechnique): void;
  dispose(): void;
}

export type RendererStatus =
  | { readonly type: "ready" }
  | { readonly type: "path_tracing_unavailable"; readonly reason: string }
  | { readonly type: "device_error"; readonly reason: string }
  | { readonly type: "device_lost"; readonly reason: string };

export type RenderFrameResult =
  | {
    readonly type: "raster";
    readonly reason:
      | "requested"
      | "camera_motion"
      | "path_tracing_fallback";
    readonly path_tracing_failure?: string;
    readonly anti_aliasing: RasterAntiAliasingResult;
    readonly visibility: RasterSceneSelection;
  }
  | {
    readonly type: "path_traced";
    readonly acceleration: RendererAccelerationUpdate;
    readonly accumulated_samples: number;
    readonly accumulation: "reset" | "continued";
    readonly cpu_oracle: RenderPickResult;
    readonly reset_reasons: readonly string[];
  };

export interface RenderPickPoint {
  readonly x: number;
  readonly y: number;
}

export type RenderPickResult =
  | { readonly type: "miss" }
  | {
    readonly type: "hit";
    readonly object_id: string;
    readonly distance: number;
  };

export interface RasterSubmittedObject {
  readonly object_id: string;
  readonly lod: string;
}

export interface RasterRejectedObject {
  readonly object_id: string;
  readonly reason: RejectionReason;
}

export interface RasterSceneSelection {
  readonly submitted: readonly RasterSubmittedObject[];
  readonly rejected: readonly RasterRejectedObject[];
}

export type RasterAntiAliasingResult =
  | { readonly type: "none" }
  | { readonly type: "fxaa" }
  | {
    readonly type: "taa";
    readonly accumulation: "reset" | "continued";
    readonly reset_reasons: readonly RasterTemporalResetReason[];
  };

export type RasterTemporalResetReason =
  | "initial"
  | "camera"
  | "scene"
  | "viewport"
  | "technique";

const gpu_buffer_usage = {
  copy_dst: 0x08,
  index: 0x10,
  uniform: 0x40,
  vertex: 0x20,
} as const;
const gpu_texture_usage = {
  copy_dst: 0x02,
  render_attachment: 0x10,
  storage_binding: 0x08,
  texture_binding: 0x04,
} as const;
const instance_float_count = 24;
const maximum_point_lights = 4;
const maximum_spot_lights = 2;
const shadow_map_size = 2048;
const render_mesh_content_keys = new WeakMap<
  readonly RenderMesh[],
  { readonly content_key: string; readonly revision: number }
>();
const render_mesh_bounds_cache = new WeakMap<
  readonly RenderMesh[],
  {
    readonly bounds: ReadonlyMap<RenderMeshId, Aabb>;
    readonly revision: number;
  }
>();
const validated_vertex_arrays = new WeakSet<Float32Array>();
const validated_index_arrays = new WeakSet<Uint32Array>();

interface ShapeGeometry {
  readonly first_vertex: number;
  readonly vertex_count: number;
}

interface ImportedGeometry {
  readonly base_vertex: number;
  readonly first_index: number;
  readonly index_count: number;
}

interface ImportedTexture {
  readonly color_space: RenderTexture["color_space"];
  readonly source: ImageBitmap;
  readonly texture: GPUTexture;
}

interface ImportedGeometrySet {
  readonly content_key: string;
  readonly index_buffer: GPUBuffer;
  readonly ranges: ReadonlyMap<RenderMeshId, ImportedGeometry>;
  readonly vertex_buffer: GPUBuffer;
}

interface AgXTextures {
  readonly hdr: GPUTexture;
  readonly sdr: GPUTexture;
}

interface RasterTargets {
  readonly depth: GPUTexture;
  readonly hdr: GPUTexture;
  readonly height: number;
  readonly history: readonly [GPUTexture, GPUTexture];
  readonly history_post_bind_groups: readonly [GPUBindGroup, GPUBindGroup];
  readonly multisample_hdr?: GPUTexture;
  readonly post_bind_group: GPUBindGroup;
  readonly revision: number;
  readonly sample_count: 1 | 4;
  readonly temporal_bind_groups: readonly [GPUBindGroup, GPUBindGroup];
  readonly width: number;
}

interface InstanceAllocation {
  readonly buffer: GPUBuffer;
  readonly capacity: number;
}

interface RasterTemporalHistory {
  readonly camera: CameraHistory;
  readonly camera_signature: string;
  readonly history_index: 0 | 1;
  readonly scene_signature: string;
  readonly target_revision: number;
}

interface RasterTemporalFrameRequest {
  readonly camera: CameraHistory;
  readonly camera_signature: string;
  readonly scene_signature: string;
  readonly target_revision: number;
}

interface RasterTemporalFramePlan {
  readonly next_history: RasterTemporalHistory;
  readonly result: Extract<RasterAntiAliasingResult, { readonly type: "taa" }>;
}

type ShapeKey = BuiltInGeometry | RenderMeshId;

export function render_mesh_id(value: string): RenderMeshId {
  return asset_id<"mesh">(value);
}

export function render_texture_id(value: string): RenderTextureId {
  return asset_id<"texture">(value);
}

export function render_color(color: RenderVector): LinearRgb {
  return linear_rgb(...color);
}

export function render_material(
  id: string,
  input: RenderMaterialInput,
): CanonicalMaterialRecord {
  const defaults = default_pbr_parameters();
  const definition = create_material_definition({
    id: material_definition_id(id),
    revision: 0,
    parameters: {
      ...defaults,
      base_color: linear_rgba(...input.albedo, 1),
      metallic: input.metallic,
      perceptual_roughness: input.roughness,
      emissive: render_color(input.emissive),
    },
    alpha: { type: "opaque" },
    sidedness: "double",
    textures: render_material_textures(input),
  });
  return canonical_material_record(definition);
}

function render_material_textures(
  input: RenderMaterialInput,
): readonly TextureBinding[] {
  const textures: TextureBinding[] = [];
  if (input.base_color_texture !== undefined) {
    textures.push(texture_binding({
      semantic: "base_color",
      texture: input.base_color_texture,
      color_space: "srgb",
      uv_set: 0,
      channels: ["r", "g", "b", "a"],
      fallback: [1, 1, 1, 1],
      sampler: {
        minification: "linear",
        magnification: "linear",
        mipmap: "linear",
        wrap_u: "repeat",
        wrap_v: "repeat",
        anisotropy: 8,
      },
    }));
  }
  if (input.normal_texture !== undefined) {
    textures.push(texture_binding({
      semantic: "normal",
      texture: input.normal_texture,
      color_space: "linear",
      uv_set: 0,
      channels: ["r", "g", "b"],
      fallback: [0, 0, 1],
      normal_y: "up",
      sampler: {
        minification: "linear",
        magnification: "linear",
        mipmap: "linear",
        wrap_u: "repeat",
        wrap_v: "repeat",
        anisotropy: 8,
      },
    }));
  }
  return textures;
}

export function render_scene_node(
  index: number,
  input: {
    readonly position: RenderVector;
    readonly rotation:
      | { readonly type: "y_axis"; readonly radians: number }
      | { readonly type: "euler_xyz"; readonly radians: RenderVector };
    readonly scale: RenderVector;
    readonly parent?: SceneNodeId;
    readonly visible?: boolean;
  },
): SceneNodeSource {
  const rotation = input.rotation.type === "y_axis"
    ? quat_from_axis_angle(vec3(0, 1, 0), input.rotation.radians)
    : quat_multiply(
      quat_multiply(
        quat_from_axis_angle(vec3(1, 0, 0), input.rotation.radians[0]),
        quat_from_axis_angle(vec3(0, 1, 0), input.rotation.radians[1]),
      ),
      quat_from_axis_angle(vec3(0, 0, 1), input.rotation.radians[2]),
    );
  const node: SceneNodeSource = {
    id: scene_node_id(index, 0),
    ...(input.parent === undefined ? {} : { parent: input.parent }),
    local_transform: transform(
      vec3(...input.position),
      rotation,
      vec3(...input.scale),
    ),
    active: input.visible ?? true,
    layers: 0xffff_ffff,
  };
  return Object.freeze(node);
}

export function render_scene_hierarchy(
  id: string,
  revision: number,
  nodes: readonly SceneNodeSource[],
): SceneSource {
  return Object.freeze({ id: scene_id(id), revision, nodes });
}

export function render_node_id(index: number): SceneNodeId {
  return scene_node_id(index, 0);
}

export function perspective_render_camera(
  id: string,
  input: {
    readonly position: RenderVector;
    readonly target: RenderVector;
    readonly vertical_fov_radians: number;
    readonly clear_color: RenderVector;
  },
): CameraDefinition {
  return render_camera(id, input, {
    type: "perspective",
    vertical_fov_radians: input.vertical_fov_radians,
    near: 0.05,
    far: 200,
    depth: "standard",
  });
}

export function orthographic_render_camera(
  id: string,
  input: {
    readonly position: RenderVector;
    readonly target: RenderVector;
    readonly vertical_size: number;
    readonly clear_color: RenderVector;
  },
): CameraDefinition {
  return render_camera(id, input, {
    type: "orthographic",
    vertical_size: input.vertical_size,
    near: 0.05,
    far: 200,
    depth: "standard",
  });
}

export function render_directional_light(
  id: string,
  input: {
    readonly color: RenderVector;
    readonly direction: RenderVector;
    readonly illuminance_lux: number;
  },
): LightDefinition {
  return create_light({
    ...render_light_base(id, input.color),
    type: "directional",
    direction: vec3(...input.direction),
    illuminance_lux: input.illuminance_lux,
    angular_diameter_radians: 0.0093,
  });
}

export function render_point_light(
  id: string,
  input: {
    readonly color: RenderVector;
    readonly position: RenderVector;
    readonly intensity_candela: number;
    readonly range: number;
  },
): LightDefinition {
  return create_light({
    ...render_light_base(id, input.color),
    type: "point",
    position: vec3(...input.position),
    intensity_candela: input.intensity_candela,
    range: input.range,
    source_radius: 0.01,
  });
}

export function render_spot_light(
  id: string,
  input: {
    readonly color: RenderVector;
    readonly position: RenderVector;
    readonly direction: RenderVector;
    readonly intensity_candela: number;
    readonly range: number;
    readonly outer_angle_radians: number;
  },
): LightDefinition {
  return create_light({
    ...render_light_base(id, input.color),
    type: "spot",
    position: vec3(...input.position),
    direction: vec3(...input.direction),
    intensity_candela: input.intensity_candela,
    range: input.range,
    inner_angle_radians: input.outer_angle_radians * 0.8,
    outer_angle_radians: input.outer_angle_radians,
    source_radius: 0.01,
  });
}

function render_camera(
  id: string,
  input: {
    readonly position: RenderVector;
    readonly target: RenderVector;
    readonly clear_color: RenderVector;
  },
  projection: CameraDefinition["projection"],
): CameraDefinition {
  const direction: RenderVector = [
    input.target[0] - input.position[0],
    input.target[1] - input.position[1],
    input.target[2] - input.position[2],
  ];
  const length = Math.hypot(...direction);
  if (length === 0) {
    throw new Error(
      `render camera ${JSON.stringify(id)} position and target must differ`,
    );
  }
  const yaw = -Math.atan2(direction[0], -direction[2]);
  const pitch = Math.asin(direction[1] / length);
  const camera: CameraDefinition = {
    id: camera_id(id),
    pose: {
      position: vec3(...input.position),
      rotation: quat_multiply(
        quat_from_axis_angle(vec3(0, 1, 0), yaw),
        quat_from_axis_angle(vec3(1, 0, 0), pitch),
      ),
    },
    projection,
    viewport: { x: 0, y: 0, width: 1, height: 1 },
    layers: 0xffff_ffff,
    order: 0,
    clear: {
      type: "color",
      color: [
        input.clear_color[0],
        input.clear_color[1],
        input.clear_color[2],
        1,
      ],
    },
  };
  return Object.freeze(camera);
}

type RenderLightBase = Pick<
  Extract<LightDefinition, { readonly type: "directional" }>,
  "id" | "revision" | "color" | "layers" | "importance" | "shadow"
>;

function render_light_base(
  id: string,
  color: RenderVector,
): RenderLightBase {
  return {
    id: light_id(id),
    revision: 0,
    color: render_color(color),
    layers: 0xffff_ffff,
    importance: 1,
    shadow: { type: "off" },
  };
}

export function render_technique(
  technique: RenderTechnique,
): RenderTechnique {
  if (technique.type === "path_traced") {
    if (
      !Number.isSafeInteger(technique.samples_per_frame) ||
      technique.samples_per_frame <= 0 || technique.samples_per_frame > 64
    ) {
      throw new Error(
        `path-traced samples per frame ${technique.samples_per_frame} must be a safe integer within [1, 64]`,
      );
    }
    if (
      !Number.isSafeInteger(technique.maximum_bounces) ||
      technique.maximum_bounces <= 0 || technique.maximum_bounces > 16
    ) {
      throw new Error(
        `path-traced maximum bounces ${technique.maximum_bounces} must be a safe integer within [1, 16]`,
      );
    }
    if (
      !Number.isFinite(technique.render_scale) ||
      technique.render_scale <= 0 || technique.render_scale > 1
    ) {
      throw new Error(
        `path-traced render scale ${technique.render_scale} must be within (0, 1]`,
      );
    }
    if (technique.denoiser !== "edge_aware") {
      throw new Error(
        `path-traced denoiser ${
          JSON.stringify(technique.denoiser)
        } is unsupported`,
      );
    }
    return Object.freeze({ ...technique });
  }
  const raster_path: string = technique.path;
  if (raster_path !== "clustered_forward") {
    throw new Error(
      `raster path ${
        JSON.stringify(raster_path)
      } is unsupported; expected "clustered_forward"`,
    );
  }
  if (technique.sample_count !== 1 && technique.sample_count !== 4) {
    throw new Error(
      `raster sample count ${
        JSON.stringify(technique.sample_count)
      } must be 1 or 4`,
    );
  }
  if (
    technique.anti_aliasing !== "none" &&
    technique.anti_aliasing !== "fxaa" && technique.anti_aliasing !== "taa"
  ) {
    throw new Error(
      `raster anti-aliasing ${
        JSON.stringify(technique.anti_aliasing)
      } is unsupported`,
    );
  }
  return Object.freeze({ ...technique });
}

interface RendererDeviceSession {
  readonly renderer: Renderer;
  readonly lost: Promise<string>;
}

type RendererRecoveryState =
  | { readonly type: "active" }
  | { readonly type: "recovering"; readonly reason: string }
  | { readonly type: "failed"; readonly reason: string };

export async function create_renderer(
  options: RendererOptions,
): Promise<Renderer> {
  const canvas = options.canvas;
  let selected_output_mode: RenderOutputMode = "sdr";
  let selected_technique = render_technique(options.technique);
  let session = await create_renderer_device_session({
    canvas,
    output_mode: selected_output_mode,
    technique: selected_technique,
  });
  let recovery: RendererRecoveryState = Object.freeze({ type: "active" });
  let disposed = false;
  let retired_validation_error_count = 0;

  async function recover(
    lost_session: RendererDeviceSession,
    loss: string,
  ): Promise<void> {
    lost_session.renderer.dispose();
    try {
      const replacement = await create_renderer_device_session({
        canvas,
        output_mode: selected_output_mode,
        technique: selected_technique,
      });
      if (disposed || session !== lost_session) {
        replacement.renderer.dispose();
        return;
      }
      session = replacement;
      recovery = Object.freeze({ type: "active" });
      watch_device_loss(replacement);
    } catch (error) {
      if (disposed || session !== lost_session) return;
      recovery = Object.freeze({
        type: "failed",
        reason: `WebGPU device recovery failed after ${loss}: ${
          render_error_message(error)
        }`,
      });
    }
  }

  function watch_device_loss(observed: RendererDeviceSession): void {
    void observed.lost.then((loss) => {
      if (disposed || session !== observed) return;
      retired_validation_error_count +=
        observed.renderer.validation_error_count;
      recovery = Object.freeze({
        type: "recovering",
        reason: `${loss}; renderer is recovering`,
      });
      void recover(observed, loss);
    });
  }
  watch_device_loss(session);

  const active_renderer = (): Renderer => {
    if (disposed) throw new Error("render renderer is disposed");
    if (recovery.type !== "active") throw new Error(recovery.reason);
    return session.renderer;
  };

  return {
    get adapter_description() {
      return session.renderer.adapter_description;
    },
    get hdr_output() {
      return session.renderer.hdr_output;
    },
    get output_mode() {
      return selected_output_mode;
    },
    get status(): RendererStatus {
      if (recovery.type === "recovering") {
        return Object.freeze({
          type: "device_lost",
          reason: recovery.reason,
        });
      }
      if (recovery.type === "failed") {
        return Object.freeze({
          type: "device_error",
          reason: recovery.reason,
        });
      }
      return session.renderer.status;
    },
    get technique() {
      return selected_technique;
    },
    get validation_error_count() {
      return retired_validation_error_count +
        (recovery.type === "active"
          ? session.renderer.validation_error_count
          : 0);
    },
    pick(scene, point) {
      return active_renderer().pick(scene, point);
    },
    render(scene) {
      return active_renderer().render(scene);
    },
    set_output_mode(output_mode) {
      const renderer = active_renderer();
      renderer.set_output_mode(output_mode);
      selected_output_mode = renderer.output_mode;
    },
    set_technique(technique) {
      const renderer = active_renderer();
      renderer.set_technique(technique);
      selected_technique = renderer.technique;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      session.renderer.dispose();
    },
  };
}

async function create_renderer_device_session(
  options: RendererOptions & { readonly output_mode: RenderOutputMode },
): Promise<RendererDeviceSession> {
  const { canvas } = options;
  let output_mode = options.output_mode;
  let technique = options.technique;
  if (!navigator.gpu) throw new Error("WebGPU is unavailable");
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: "high-performance",
    forceFallbackAdapter: false,
  });
  if (adapter === null) throw new Error("no WebGPU adapter is available");
  if (adapter.info.isFallbackAdapter) {
    throw new Error("the WebGPU adapter is a software fallback");
  }
  const device = await adapter.requestDevice();
  const rendering_context = canvas.getContext("webgpu");
  if (!is_gpu_canvas_context(rendering_context)) {
    device.destroy();
    throw new Error("the canvas did not provide a WebGPU context");
  }
  const context = rendering_context;
  const format: GPUTextureFormat = "rgba16float";
  configure_canvas(context, device, format, "sdr");
  const hdr_output = detect_hdr_output(context);
  if (output_mode === "hdr") {
    if (hdr_output.type === "unavailable") {
      context.unconfigure();
      device.destroy();
      throw new Error(`HDR output is unavailable: ${hdr_output.reason}`);
    }
    configure_canvas(context, device, format, "hdr");
  }

  const scene_module = device.createShaderModule({
    code: raster_scene_shader.source,
  });
  const shadow_module = device.createShaderModule({
    code: raster_shadow_shader.source,
  });
  const mipmap_module = device.createShaderModule({
    code: raster_mipmap_shader.source,
  });
  const post_module = device.createShaderModule({
    code: raster_post_shader.source,
  });
  const temporal_module = device.createShaderModule({
    code: raster_temporal_shader.source,
  });
  const compiled_shaders = [
    { module: scene_module, source: raster_scene_shader },
    { module: shadow_module, source: raster_shadow_shader },
    { module: mipmap_module, source: raster_mipmap_shader },
    { module: post_module, source: raster_post_shader },
    { module: temporal_module, source: raster_temporal_shader },
  ] as const;
  const shader_messages = await Promise.all(
    compiled_shaders.map(({ module }) => module.getCompilationInfo()),
  );
  const shader_errors = shader_messages.flatMap(({ messages }, index) =>
    [...messages].filter(({ type }) => type === "error").map((message) =>
      format_shader_compilation_diagnostic(
        compiled_shaders[index].source,
        message,
      )
    )
  );
  if (shader_errors.length > 0) {
    context.unconfigure();
    device.destroy();
    throw new Error(
      `render shader failed: ${shader_errors.join("; ")}`,
    );
  }

  const instance_layout: GPUVertexBufferLayout = {
    arrayStride: instance_float_count * 4,
    stepMode: "instance",
    attributes: [
      { shaderLocation: 2, offset: 0, format: "float32x4" },
      { shaderLocation: 3, offset: 16, format: "float32x4" },
      { shaderLocation: 4, offset: 32, format: "float32x4" },
      { shaderLocation: 5, offset: 48, format: "float32x4" },
      { shaderLocation: 6, offset: 64, format: "float32x4" },
      { shaderLocation: 7, offset: 80, format: "float32x4" },
    ],
  };
  const geometry_layout: GPUVertexBufferLayout = {
    arrayStride: 32,
    attributes: [
      { shaderLocation: 0, offset: 0, format: "float32x3" },
      { shaderLocation: 1, offset: 12, format: "float32x3" },
      { shaderLocation: 8, offset: 24, format: "float32x2" },
    ],
  };

  const scene_pipelines: Readonly<Record<1 | 4, GPURenderPipeline>> = {
    1: await create_raster_scene_pipeline(
      device,
      scene_module,
      geometry_layout,
      instance_layout,
      1,
    ),
    4: await create_raster_scene_pipeline(
      device,
      scene_module,
      geometry_layout,
      instance_layout,
      4,
    ),
  };
  const shadow_pipeline = await device.createRenderPipelineAsync({
    layout: "auto",
    vertex: {
      module: shadow_module,
      entryPoint: "vertex_main",
      buffers: [geometry_layout, instance_layout],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth32float",
      depthWriteEnabled: true,
      depthCompare: "less",
      depthBias: 2,
      depthBiasSlopeScale: 2,
    },
  });
  const post_pipeline = await device.createRenderPipelineAsync({
    layout: "auto",
    vertex: { module: post_module, entryPoint: "vertex_main" },
    fragment: {
      module: post_module,
      entryPoint: "fragment_main",
      targets: [{ format }],
    },
    primitive: { topology: "triangle-list" },
  });
  const temporal_pipeline = await device.createRenderPipelineAsync({
    layout: "auto",
    vertex: { module: temporal_module, entryPoint: "vertex_main" },
    fragment: {
      module: temporal_module,
      entryPoint: "fragment_main",
      targets: [{ format: "rgba16float" }],
    },
    primitive: { topology: "triangle-list" },
  });
  const mipmap_pipelines: Readonly<
    Record<RenderTexture["color_space"], GPURenderPipeline>
  > = {
    linear: await create_mipmap_pipeline(
      device,
      mipmap_module,
      "rgba8unorm",
    ),
    srgb: await create_mipmap_pipeline(
      device,
      mipmap_module,
      "rgba8unorm-srgb",
    ),
  };

  const geometry = build_geometry();
  const geometry_buffer = create_buffer(
    device,
    geometry.vertices,
    gpu_buffer_usage.vertex,
  );
  let imported_geometry = create_imported_geometry_set(device, []);
  const imported_textures = new Map<RenderTextureId, ImportedTexture>();
  const material_sampler = device.createSampler({
    addressModeU: "repeat",
    addressModeV: "repeat",
    magFilter: "linear",
    minFilter: "linear",
    mipmapFilter: "linear",
    maxAnisotropy: 8,
  });
  const mipmap_sampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
  });
  const fallback_material_textures = create_fallback_material_textures(device);
  const agx_textures = create_agx_textures(device);
  const material_bind_group_layouts: Readonly<
    Record<1 | 4, GPUBindGroupLayout>
  > = {
    1: scene_pipelines[1].getBindGroupLayout(1),
    4: scene_pipelines[4].getBindGroupLayout(1),
  };
  const fallback_material_bind_groups: Readonly<
    Record<1 | 4, GPUBindGroup>
  > = {
    1: create_material_bind_group(
      device,
      material_bind_group_layouts[1],
      material_sampler,
      fallback_material_textures.base_color,
      fallback_material_textures.normal,
    ),
    4: create_material_bind_group(
      device,
      material_bind_group_layouts[4],
      material_sampler,
      fallback_material_textures.base_color,
      fallback_material_textures.normal,
    ),
  };
  const material_bind_groups: Readonly<
    Record<1 | 4, Map<string, GPUBindGroup>>
  > = { 1: new Map(), 4: new Map() };
  let raster_instances = create_instance_allocation(device);
  let shadow_instances = create_instance_allocation(device);
  const frame_buffer = device.createBuffer({
    size: frame_uniform_float_count() * 4,
    usage: gpu_buffer_usage.uniform | gpu_buffer_usage.copy_dst,
  });
  const shadow_buffer = device.createBuffer({
    size: 16 * 4,
    usage: gpu_buffer_usage.uniform | gpu_buffer_usage.copy_dst,
  });
  const post_buffer = device.createBuffer({
    size: 32,
    usage: gpu_buffer_usage.uniform | gpu_buffer_usage.copy_dst,
  });
  const temporal_buffer = device.createBuffer({
    size: 16,
    usage: gpu_buffer_usage.uniform | gpu_buffer_usage.copy_dst,
  });
  const shadow_texture = device.createTexture({
    size: [shadow_map_size, shadow_map_size],
    format: "depth32float",
    usage: gpu_texture_usage.render_attachment |
      gpu_texture_usage.texture_binding,
  });
  const shadow_sampler = device.createSampler({
    compare: "less-equal",
    magFilter: "linear",
    minFilter: "linear",
  });
  const scene_bind_groups: Readonly<Record<1 | 4, GPUBindGroup>> = {
    1: create_scene_bind_group(
      device,
      scene_pipelines[1],
      frame_buffer,
      shadow_texture,
      shadow_sampler,
    ),
    4: create_scene_bind_group(
      device,
      scene_pipelines[4],
      frame_buffer,
      shadow_texture,
      shadow_sampler,
    ),
  };
  const shadow_bind_group = device.createBindGroup({
    layout: shadow_pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: shadow_buffer } }],
  });
  const hdr_sampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
  });
  let path_tracing_compute: PathTracingCompute | undefined;
  let path_tracing_initialization_failure: string | undefined;
  try {
    path_tracing_compute = await create_path_tracing_compute(device);
  } catch (error) {
    path_tracing_initialization_failure =
      `path tracing initialization failed: ${render_error_message(error)}`;
  }
  const built_in_path_geometry = new Map(
    [...geometry.shapes].map(([shape, range]) => [
      shape,
      { ...range, vertices: geometry.vertices },
    ]),
  );
  let targets: RasterTargets | undefined;
  let target_revision = 0;
  let validation_error_count = 0;
  let disposed = false;
  let resources_released = false;
  let device_failure: string | undefined;
  let device_loss: string | undefined;
  let path_tracing_runtime_failure: string | undefined;
  let path_tracing_history: PathTracingFrameHistory | undefined;
  let previous_path_camera_revision: number | undefined;
  let synchronized_textures: readonly RenderTexture[] = [];
  let batched_objects: readonly RenderObject[] = [];
  let batched_hierarchy: SceneSource | undefined;
  let batches = empty_scene_instances();
  let shadow_batches = empty_scene_instances();
  let previous_visibility: VisibleSet | undefined;
  const visibility_pipeline = new VisibilityPipeline();
  let raster_temporal_history: RasterTemporalHistory | undefined;
  let pending_temporal_reset: RasterTemporalResetReason = "initial";
  let frame_sequence = 0;

  const report_uncaptured_error = (event: GPUUncapturedErrorEvent) => {
    validation_error_count += 1;
    const failure = `uncaptured WebGPU error: ${event.error.message}`;
    if (technique.type === "path_traced") {
      path_tracing_runtime_failure = failure;
      path_tracing_history = undefined;
      return;
    }
    device_failure = failure;
  };
  device.addEventListener("uncapturederror", report_uncaptured_error);
  const device_loss_event = device.lost.then(({ message, reason }) => {
    const loss = `WebGPU device lost (${reason}): ${message}`;
    if (!disposed) {
      device_loss = loss;
      release_gpu_resources();
      context.unconfigure();
    }
    return loss;
  });

  function ensure_targets(sample_count: 1 | 4): RasterTargets {
    const pixel_ratio = Math.max(1, globalThis.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(canvas.clientWidth * pixel_ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * pixel_ratio));
    if (
      width === targets?.width && height === targets.height &&
      sample_count === targets.sample_count
    ) return targets;
    canvas.width = width;
    canvas.height = height;
    targets?.depth.destroy();
    targets?.hdr.destroy();
    targets?.multisample_hdr?.destroy();
    targets?.history[0].destroy();
    targets?.history[1].destroy();
    const depth = device.createTexture({
      size: [width, height],
      sampleCount: sample_count,
      format: "depth24plus",
      usage: gpu_texture_usage.render_attachment,
    });
    const hdr = device.createTexture({
      size: [width, height],
      format: "rgba16float",
      usage: gpu_texture_usage.render_attachment |
        gpu_texture_usage.texture_binding | gpu_texture_usage.storage_binding,
    });
    const multisample_hdr = sample_count === 1
      ? undefined
      : device.createTexture({
        size: [width, height],
        sampleCount: sample_count,
        format: "rgba16float",
        usage: gpu_texture_usage.render_attachment,
      });
    const history: [GPUTexture, GPUTexture] = [
      device.createTexture({
        size: [width, height],
        format: "rgba16float",
        usage: gpu_texture_usage.render_attachment |
          gpu_texture_usage.texture_binding,
      }),
      device.createTexture({
        size: [width, height],
        format: "rgba16float",
        usage: gpu_texture_usage.render_attachment |
          gpu_texture_usage.texture_binding,
      }),
    ];
    const post_bind_group = create_post_bind_group(
      device,
      post_pipeline,
      hdr,
      hdr_sampler,
      post_buffer,
      agx_textures,
    );
    const history_post_bind_groups: [GPUBindGroup, GPUBindGroup] = [
      create_post_bind_group(
        device,
        post_pipeline,
        history[0],
        hdr_sampler,
        post_buffer,
        agx_textures,
      ),
      create_post_bind_group(
        device,
        post_pipeline,
        history[1],
        hdr_sampler,
        post_buffer,
        agx_textures,
      ),
    ];
    const temporal_bind_groups: [GPUBindGroup, GPUBindGroup] = [
      create_temporal_bind_group(
        device,
        temporal_pipeline,
        hdr,
        history[1],
        hdr_sampler,
        temporal_buffer,
      ),
      create_temporal_bind_group(
        device,
        temporal_pipeline,
        hdr,
        history[0],
        hdr_sampler,
        temporal_buffer,
      ),
    ];
    target_revision += 1;
    targets = {
      depth,
      hdr,
      height,
      history,
      history_post_bind_groups,
      ...(multisample_hdr === undefined ? {} : { multisample_hdr }),
      post_bind_group,
      revision: target_revision,
      sample_count,
      temporal_bind_groups,
      width,
    };
    return targets;
  }

  function encode_raster_frame(
    commands: GPUCommandEncoder,
    scene: RenderScene,
    target: RasterTargets,
  ): void {
    const shadow_pass = commands.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: shadow_texture.createView(),
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });
    shadow_pass.setPipeline(shadow_pipeline);
    shadow_pass.setBindGroup(0, shadow_bind_group);
    draw_batches(
      shadow_pass,
      geometry,
      geometry_buffer,
      imported_geometry,
      shadow_instances.buffer,
      shadow_batches.batches,
      undefined,
    );
    shadow_pass.end();

    const scene_pass = commands.beginRenderPass({
      colorAttachments: [{
        view: (target.multisample_hdr ?? target.hdr).createView(),
        ...(target.multisample_hdr === undefined
          ? {}
          : { resolveTarget: target.hdr.createView() }),
        clearValue: camera_clear_color(scene.camera),
        loadOp: "clear",
        storeOp: target.multisample_hdr === undefined ? "store" : "discard",
      }],
      depthStencilAttachment: {
        view: target.depth.createView(),
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });
    scene_pass.setPipeline(scene_pipelines[target.sample_count]);
    scene_pass.setBindGroup(0, scene_bind_groups[target.sample_count]);
    draw_batches(
      scene_pass,
      geometry,
      geometry_buffer,
      imported_geometry,
      raster_instances.buffer,
      batches.batches,
      {
        fallback: fallback_material_bind_groups[target.sample_count],
        bind_groups: material_bind_groups[target.sample_count],
        device,
        fallback_textures: fallback_material_textures,
        layout: material_bind_group_layouts[target.sample_count],
        sampler: material_sampler,
        textures: imported_textures,
      },
    );
    scene_pass.end();
  }

  function encode_post_process(
    commands: GPUCommandEncoder,
    target: RasterTargets,
    source: "hdr" | 0 | 1,
  ): void {
    const post_pass = commands.beginRenderPass({
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    post_pass.setPipeline(post_pipeline);
    post_pass.setBindGroup(
      0,
      source === "hdr"
        ? target.post_bind_group
        : target.history_post_bind_groups[source],
    );
    post_pass.draw(3);
    post_pass.end();
  }

  function encode_temporal_accumulation(
    commands: GPUCommandEncoder,
    target: RasterTargets,
    output: 0 | 1,
  ): void {
    const temporal_pass = commands.beginRenderPass({
      colorAttachments: [{
        view: target.history[output].createView(),
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    temporal_pass.setPipeline(temporal_pipeline);
    temporal_pass.setBindGroup(0, target.temporal_bind_groups[output]);
    temporal_pass.draw(3);
    temporal_pass.end();
  }

  function render_raster_frame(
    scene: RenderScene,
    target: RasterTargets,
    camera_frame: CameraFrame,
    reason: Extract<RenderFrameResult, { readonly type: "raster" }>["reason"],
    path_failure?: string,
    visibility: RasterSceneSelection = empty_raster_scene_selection(),
  ): RenderFrameResult {
    const commands = device.createCommandEncoder();
    encode_raster_frame(commands, scene, target);
    let anti_aliasing: RasterAntiAliasingResult;
    let post_source: "hdr" | 0 | 1 = "hdr";
    if (technique.type === "raster" && technique.anti_aliasing === "taa") {
      const temporal = next_raster_temporal_frame(
        raster_temporal_history,
        {
          camera: camera_frame.history,
          camera_signature: raster_camera_signature(scene.camera),
          scene_signature: raster_scene_signature(
            scene,
            imported_geometry.content_key,
          ),
          target_revision: target.revision,
        },
        pending_temporal_reset,
      );
      raster_temporal_history = temporal.next_history;
      pending_temporal_reset = "initial";
      device.queue.writeBuffer(
        temporal_buffer,
        0,
        new Float32Array([
          temporal.result.accumulation === "continued" ? 0.9 : 0,
          1 / target.width,
          1 / target.height,
          0,
        ]),
      );
      encode_temporal_accumulation(
        commands,
        target,
        temporal.next_history.history_index,
      );
      post_source = temporal.next_history.history_index;
      anti_aliasing = temporal.result;
    } else {
      anti_aliasing = Object.freeze({
        type: technique.type === "raster" &&
            technique.anti_aliasing === "fxaa"
          ? "fxaa"
          : "none",
      });
    }
    encode_post_process(commands, target, post_source);
    device.queue.submit([commands.finish()]);
    return Object.freeze({
      type: "raster",
      reason,
      anti_aliasing,
      visibility,
      ...(path_failure === undefined
        ? {}
        : { path_tracing_failure: path_failure }),
    });
  }

  function monitor_path_validation(
    validation: Promise<GPUError | null>,
  ): void {
    void validation.then((error) => {
      if (error === null || disposed || device_loss !== undefined) return;
      validation_error_count += 1;
      path_tracing_runtime_failure =
        `path tracing validation failed: ${error.message}`;
      path_tracing_history = undefined;
    }).catch((error) => {
      if (disposed || device_loss !== undefined) return;
      path_tracing_runtime_failure = `path tracing validation scope failed: ${
        render_error_message(error)
      }`;
      path_tracing_history = undefined;
    });
  }

  function release_gpu_resources(): void {
    if (resources_released) return;
    resources_released = true;
    geometry_buffer.destroy();
    imported_geometry.vertex_buffer.destroy();
    imported_geometry.index_buffer.destroy();
    for (const imported of imported_textures.values()) {
      imported.texture.destroy();
    }
    imported_textures.clear();
    fallback_material_textures.base_color.destroy();
    fallback_material_textures.normal.destroy();
    agx_textures.hdr.destroy();
    agx_textures.sdr.destroy();
    raster_instances.buffer.destroy();
    shadow_instances.buffer.destroy();
    frame_buffer.destroy();
    shadow_buffer.destroy();
    post_buffer.destroy();
    temporal_buffer.destroy();
    shadow_texture.destroy();
    targets?.depth.destroy();
    targets?.hdr.destroy();
    targets?.multisample_hdr?.destroy();
    targets?.history[0].destroy();
    targets?.history[1].destroy();
    path_tracing_compute?.dispose();
    path_tracing_compute = undefined;
  }

  const renderer: Renderer = {
    adapter_description: adapter.info.description || adapter.info.vendor ||
      "WebGPU adapter",
    hdr_output,
    get output_mode() {
      return output_mode;
    },
    get status(): RendererStatus {
      if (device_loss !== undefined) {
        return Object.freeze({ type: "device_lost", reason: device_loss });
      }
      if (device_failure !== undefined) {
        return Object.freeze({ type: "device_error", reason: device_failure });
      }
      const path_failure = path_tracing_initialization_failure ??
        path_tracing_runtime_failure;
      return path_failure === undefined
        ? Object.freeze({ type: "ready" })
        : Object.freeze({
          type: "path_tracing_unavailable",
          reason: path_failure,
        });
    },
    get technique() {
      return technique;
    },
    get validation_error_count() {
      return validation_error_count;
    },
    pick(scene, point) {
      if (disposed) throw new Error("render renderer is disposed");
      if (device_loss !== undefined) throw new Error(device_loss);
      if (device_failure !== undefined) throw new Error(device_failure);
      const sample_count = technique.type === "raster"
        ? technique.sample_count
        : 1;
      const target = ensure_targets(sample_count);
      return pick_render_scene(scene, {
        ...point,
        width: target.width,
        height: target.height,
      });
    },
    render(scene) {
      if (disposed) throw new Error("render renderer is disposed");
      if (device_loss !== undefined) throw new Error(device_loss);
      if (device_failure !== undefined) throw new Error(device_failure);
      validate_render_scene(scene);
      const sample_count = technique.type === "raster"
        ? technique.sample_count
        : 1;
      const target = ensure_targets(sample_count);
      const raster_uses_taa = technique.type === "raster" &&
        technique.anti_aliasing === "taa";
      const camera_frame = render_camera_frame(
        scene.camera,
        target.width,
        target.height,
        frame_sequence,
        raster_uses_taa ? raster_temporal_history?.camera : undefined,
        raster_uses_taa ? 1 : 0,
      );
      const camera_view = camera_frame.view;
      frame_sequence += 1;
      const mesh_content_key = scene.mesh_metadata?.content_key ??
        render_mesh_content_key(scene.meshes, scene.mesh_revision);
      if (imported_geometry.content_key !== mesh_content_key) {
        imported_geometry.vertex_buffer.destroy();
        imported_geometry.index_buffer.destroy();
        imported_geometry = create_imported_geometry_set(
          device,
          scene.meshes,
          mesh_content_key,
        );
      }
      if (
        synchronized_textures !== scene.textures &&
        !same_render_textures(synchronized_textures, scene.textures)
      ) {
        synchronize_imported_textures(
          device,
          imported_textures,
          mipmap_pipelines,
          mipmap_sampler,
          scene.textures,
        );
        material_bind_groups[1].clear();
        material_bind_groups[4].clear();
        if (path_tracing_history !== undefined) {
          path_tracing_history = Object.freeze({
            source: path_tracing_history.source,
            packed_scene: path_tracing_history.packed_scene,
          });
        }
        if (raster_temporal_history !== undefined) {
          raster_temporal_history = undefined;
          pending_temporal_reset = "scene";
        }
      }
      synchronized_textures = scene.textures;
      if (
        batched_objects !== scene.objects ||
        batched_hierarchy !== scene.hierarchy
      ) {
        shadow_batches = scene_instances(scene);
        batched_objects = scene.objects;
        batched_hierarchy = scene.hierarchy;
        shadow_instances = upload_scene_instances(
          device,
          shadow_instances,
          shadow_batches,
        );
      }
      const evaluated_visibility = evaluate_raster_scene(
        scene,
        camera_view,
        visibility_pipeline,
        previous_visibility,
      );
      previous_visibility = evaluated_visibility.visible_set;
      batches = scene_instances(scene, evaluated_visibility.selection);
      raster_instances = upload_scene_instances(
        device,
        raster_instances,
        batches,
      );
      const directional = scene.lights.find((light) =>
        light.type === "directional"
      );
      const light_view_projection = light_matrix(directional, scene.camera);
      device.queue.writeBuffer(
        frame_buffer,
        0,
        frame_uniform(
          scene,
          raster_uses_taa
            ? camera_view.jittered_view_projection
            : camera_view.stable_view_projection,
          light_view_projection,
        ),
      );
      device.queue.writeBuffer(
        shadow_buffer,
        0,
        new Float32Array(light_view_projection),
      );
      device.queue.writeBuffer(
        post_buffer,
        0,
        new Float32Array([
          scene.environment.exposure_ev100,
          scene.environment.bloom_intensity,
          output_mode === "hdr" ? 1 : 0,
          0,
          1 / target.width,
          1 / target.height,
          technique.type === "raster" && technique.anti_aliasing === "fxaa"
            ? 1
            : 0,
          0,
        ]),
      );

      if (technique.type === "raster") {
        return render_raster_frame(
          scene,
          target,
          camera_frame,
          "requested",
          undefined,
          evaluated_visibility.selection,
        );
      }
      const path_failure = path_tracing_initialization_failure ??
        path_tracing_runtime_failure;
      if (path_failure !== undefined || path_tracing_compute === undefined) {
        return render_raster_frame(
          scene,
          target,
          camera_frame,
          "path_tracing_fallback",
          path_failure ?? "path tracing compute is unavailable",
          evaluated_visibility.selection,
        );
      }

      let planned: ReturnType<typeof plan_path_tracing_frame>;
      let cpu_oracle: RenderPickResult = Object.freeze({ type: "miss" });
      let instance_objects: PathTracingRenderSceneSnapshot["instance_objects"] =
        [];
      try {
        const snapshot = path_tracing_render_scene_snapshot(
          scene,
          built_in_path_geometry,
          { width: target.width, height: target.height },
          technique,
        );
        instance_objects = snapshot.instance_objects;
        const camera_moving = previous_path_camera_revision !== undefined &&
          previous_path_camera_revision !==
            snapshot.presentation.camera_revision;
        previous_path_camera_revision = snapshot.presentation.camera_revision;
        planned = plan_path_tracing_frame(path_tracing_history, {
          ...snapshot,
          camera_moving,
        });
        if (planned.type === "path_traced") {
          const cast = screen_ray(
            camera_view,
            target.width / 2,
            target.height / 2,
          );
          if (cast.type !== "ready") {
            throw new Error(
              `render camera ${cast.camera} ${cast.operation}: ${cast.reason}`,
            );
          }
          const hit = trace_ray(planned.packed_scene, cast.value);
          if (hit !== null) {
            const object = instance_objects.find(({ instance }) =>
              instance === hit.instance
            );
            if (object === undefined) {
              throw new Error(
                `path tracing CPU oracle hit unmapped instance ${hit.instance}`,
              );
            }
            cpu_oracle = Object.freeze({
              type: "hit",
              object_id: object.object_id,
              distance: hit.distance,
            });
          }
        }
      } catch (error) {
        path_tracing_runtime_failure = `path tracing scene failed: ${
          render_error_message(error)
        }`;
        path_tracing_history = undefined;
        return render_raster_frame(
          scene,
          target,
          camera_frame,
          "path_tracing_fallback",
          path_tracing_runtime_failure,
          evaluated_visibility.selection,
        );
      }
      if (planned.type === "raster_preview") {
        path_tracing_history = planned.next_history;
        return render_raster_frame(
          scene,
          target,
          camera_frame,
          "camera_motion",
          undefined,
          evaluated_visibility.selection,
        );
      }
      const inverse_view_projection = mat4_inverse(
        camera_view.stable_view_projection,
      );
      if (!inverse_view_projection.ok) {
        path_tracing_runtime_failure =
          `path tracing camera view-projection is singular at pivot ${inverse_view_projection.pivot}`;
        path_tracing_history = undefined;
        return render_raster_frame(
          scene,
          target,
          camera_frame,
          "path_tracing_fallback",
          path_tracing_runtime_failure,
          evaluated_visibility.selection,
        );
      }
      device.pushErrorScope("validation");
      const commands = device.createCommandEncoder();
      try {
        path_tracing_compute.encode({
          ambient_light: scene.environment.ambient_light,
          camera_position: scene.camera.pose.position,
          clear_color: camera_clear_color(scene.camera),
          commands,
          fog_color: scene.environment.fog_color,
          fog_density: scene.environment.fog_density,
          hdr: target.hdr,
          inverse_view_projection: inverse_view_projection.value,
          plan: planned,
          target_height: target.height,
          target_width: target.width,
          textures: scene.textures,
        });
        encode_post_process(commands, target, "hdr");
        device.queue.submit([commands.finish()]);
      } catch (error) {
        monitor_path_validation(device.popErrorScope());
        path_tracing_runtime_failure = `path tracing execution failed: ${
          render_error_message(error)
        }`;
        path_tracing_history = undefined;
        return render_raster_frame(
          scene,
          target,
          camera_frame,
          "path_tracing_fallback",
          path_tracing_runtime_failure,
          evaluated_visibility.selection,
        );
      }
      monitor_path_validation(device.popErrorScope());
      path_tracing_history = planned.next_history;
      return Object.freeze({
        type: "path_traced",
        acceleration: planned.acceleration,
        accumulated_samples: planned.accumulation.accumulated_samples,
        accumulation: planned.accumulation.type,
        cpu_oracle,
        reset_reasons: planned.accumulation.type === "reset"
          ? planned.accumulation.reasons
          : [],
      });
    },
    set_output_mode(next) {
      if (disposed) throw new Error("render renderer is disposed");
      if (device_loss !== undefined) throw new Error(device_loss);
      if (next !== "sdr" && next !== "hdr") {
        throw new Error(
          `render output mode ${JSON.stringify(next)} is unsupported`,
        );
      }
      if (next === output_mode) return;
      if (next === "hdr" && hdr_output.type === "unavailable") {
        throw new Error(`HDR output is unavailable: ${hdr_output.reason}`);
      }
      configure_canvas(context, device, format, next);
      output_mode = next;
    },
    set_technique(next) {
      if (disposed) throw new Error("render renderer is disposed");
      if (device_loss !== undefined) throw new Error(device_loss);
      technique = render_technique(next);
      raster_temporal_history = undefined;
      pending_temporal_reset = "technique";
      path_tracing_history = undefined;
      previous_path_camera_revision = undefined;
      path_tracing_runtime_failure = undefined;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      device.removeEventListener("uncapturederror", report_uncaptured_error);
      release_gpu_resources();
      context.unconfigure();
      device.destroy();
    },
  };
  return Object.freeze({ renderer, lost: device_loss_event });
}

interface ExtendedCanvasConfiguration extends GPUCanvasConfiguration {
  readonly toneMapping: { readonly mode: "standard" | "extended" };
}

interface ConfiguredCanvasContext extends GPUCanvasContext {
  getConfiguration(): ExtendedCanvasConfiguration | null;
}

function configure_canvas(
  context: GPUCanvasContext,
  device: GPUDevice,
  format: GPUTextureFormat,
  output_mode: RenderOutputMode,
): void {
  const configuration: ExtendedCanvasConfiguration = {
    alphaMode: "opaque",
    colorSpace: "srgb",
    device,
    format,
    toneMapping: { mode: output_mode === "hdr" ? "extended" : "standard" },
  };
  context.configure(configuration);
}

function detect_hdr_output(
  context: GPUCanvasContext,
): HdrOutputAvailability {
  if (
    !("getConfiguration" in context) ||
    typeof context.getConfiguration !== "function"
  ) {
    return Object.freeze({
      type: "unavailable",
      reason: "This browser does not expose WebGPU HDR presentation.",
    });
  }
  const configuration = (context as ConfiguredCanvasContext)
    .getConfiguration();
  if (configuration?.toneMapping?.mode !== "standard") {
    return Object.freeze({
      type: "unavailable",
      reason: "This browser ignored WebGPU HDR presentation settings.",
    });
  }
  if (
    typeof globalThis.matchMedia !== "function" ||
    !globalThis.matchMedia("(dynamic-range: high)").matches
  ) {
    return Object.freeze({
      type: "unavailable",
      reason: "The active display is not reporting HDR dynamic range.",
    });
  }
  return Object.freeze({ type: "available" });
}

function create_raster_scene_pipeline(
  device: GPUDevice,
  module: GPUShaderModule,
  geometry_layout: GPUVertexBufferLayout,
  instance_layout: GPUVertexBufferLayout,
  sample_count: 1 | 4,
): Promise<GPURenderPipeline> {
  return device.createRenderPipelineAsync({
    layout: "auto",
    vertex: {
      module,
      entryPoint: "vertex_main",
      buffers: [geometry_layout, instance_layout],
    },
    fragment: {
      module,
      entryPoint: "fragment_main",
      targets: [{ format: "rgba16float" }],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth24plus",
      depthWriteEnabled: true,
      depthCompare: "less",
    },
    multisample: { count: sample_count },
  });
}

function create_scene_bind_group(
  device: GPUDevice,
  pipeline: GPURenderPipeline,
  frame_buffer: GPUBuffer,
  shadow_texture: GPUTexture,
  shadow_sampler: GPUSampler,
): GPUBindGroup {
  return device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: frame_buffer } },
      { binding: 1, resource: shadow_texture.createView() },
      { binding: 2, resource: shadow_sampler },
    ],
  });
}

function create_post_bind_group(
  device: GPUDevice,
  pipeline: GPURenderPipeline,
  texture: GPUTexture,
  sampler: GPUSampler,
  buffer: GPUBuffer,
  agx_textures: AgXTextures,
): GPUBindGroup {
  return device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: texture.createView() },
      { binding: 1, resource: sampler },
      { binding: 2, resource: { buffer } },
      { binding: 3, resource: agx_textures.sdr.createView() },
      { binding: 4, resource: agx_textures.hdr.createView() },
    ],
  });
}

function create_agx_textures(device: GPUDevice): AgXTextures {
  const textures = [AGX_HDR_LUT_BASE64, AGX_SDR_LUT_BASE64].map((encoded) => {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(
      binary,
      (character) => character.charCodeAt(0),
    );
    const expected_bytes = AGX_LUT_SIZE ** 3 * 8;
    if (bytes.byteLength !== expected_bytes) {
      throw new Error(
        `render AgX ${AGX_LUT_SIZE}³ LUT needs ${expected_bytes} bytes, received ${bytes.byteLength}`,
      );
    }
    const source_row_bytes = AGX_LUT_SIZE * 8;
    const upload_row_bytes = Math.ceil(source_row_bytes / 256) * 256;
    const upload = new Uint8Array(
      upload_row_bytes * AGX_LUT_SIZE * AGX_LUT_SIZE,
    );
    for (let row = 0; row < AGX_LUT_SIZE ** 2; row += 1) {
      const source_offset = row * source_row_bytes;
      upload.set(
        bytes.subarray(source_offset, source_offset + source_row_bytes),
        row * upload_row_bytes,
      );
    }
    const texture = device.createTexture({
      dimension: "3d",
      size: [AGX_LUT_SIZE, AGX_LUT_SIZE, AGX_LUT_SIZE],
      format: "rgba16float",
      usage: gpu_texture_usage.copy_dst | gpu_texture_usage.texture_binding,
    });
    device.queue.writeTexture(
      { texture },
      upload,
      {
        bytesPerRow: upload_row_bytes,
        rowsPerImage: AGX_LUT_SIZE,
      },
      [AGX_LUT_SIZE, AGX_LUT_SIZE, AGX_LUT_SIZE],
    );
    return texture;
  });
  return { hdr: textures[0], sdr: textures[1] };
}

function create_temporal_bind_group(
  device: GPUDevice,
  pipeline: GPURenderPipeline,
  current: GPUTexture,
  history: GPUTexture,
  sampler: GPUSampler,
  buffer: GPUBuffer,
): GPUBindGroup {
  return device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: current.createView() },
      { binding: 1, resource: history.createView() },
      { binding: 2, resource: sampler },
      { binding: 3, resource: { buffer } },
    ],
  });
}

function render_error_message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function draw_batches(
  pass: GPURenderPassEncoder,
  geometry: ReturnType<typeof build_geometry>,
  geometry_buffer: GPUBuffer,
  imported_geometry: ImportedGeometrySet,
  instance_buffer: GPUBuffer,
  batches: readonly SceneBatch[],
  materials:
    | {
      readonly bind_groups: Map<string, GPUBindGroup>;
      readonly device: GPUDevice;
      readonly fallback: GPUBindGroup;
      readonly fallback_textures: {
        readonly base_color: GPUTexture;
        readonly normal: GPUTexture;
      };
      readonly layout: GPUBindGroupLayout;
      readonly sampler: GPUSampler;
      readonly textures: ReadonlyMap<RenderTextureId, ImportedTexture>;
    }
    | undefined,
): void {
  pass.setVertexBuffer(1, instance_buffer);
  for (const batch of batches) {
    if (is_built_in_shape(batch.shape)) {
      const shape_geometry = geometry.shapes.get(batch.shape);
      if (shape_geometry === undefined) {
        throw new Error(
          `render renderer omitted built-in ${batch.shape} geometry`,
        );
      }
      pass.setVertexBuffer(0, geometry_buffer);
      if (materials !== undefined) {
        pass.setBindGroup(1, material_bind_group(materials, batch.material));
      }
      pass.draw(
        shape_geometry.vertex_count,
        batch.count,
        shape_geometry.first_vertex,
        batch.first,
      );
      continue;
    }
    const imported = imported_geometry.ranges.get(batch.shape);
    if (imported === undefined) {
      throw new Error(
        `render renderer omitted imported mesh ${JSON.stringify(batch.shape)}`,
      );
    }
    pass.setVertexBuffer(0, imported_geometry.vertex_buffer);
    pass.setIndexBuffer(imported_geometry.index_buffer, "uint32");
    if (materials !== undefined) {
      pass.setBindGroup(
        1,
        material_bind_group(materials, batch.material),
      );
    }
    pass.drawIndexed(
      imported.index_count,
      batch.count,
      imported.first_index,
      imported.base_vertex,
      batch.first,
    );
  }
}

function material_bind_group(
  materials: {
    readonly bind_groups: Map<string, GPUBindGroup>;
    readonly device: GPUDevice;
    readonly fallback: GPUBindGroup;
    readonly fallback_textures: {
      readonly base_color: GPUTexture;
      readonly normal: GPUTexture;
    };
    readonly layout: GPUBindGroupLayout;
    readonly sampler: GPUSampler;
    readonly textures: ReadonlyMap<RenderTextureId, ImportedTexture>;
  },
  material: CanonicalMaterialRecord,
): GPUBindGroup {
  const base_color_texture = material.textures.find(({ semantic }) =>
    semantic === "base_color"
  )?.texture;
  const normal_texture = material.textures.find(({ semantic }) =>
    semantic === "normal"
  )?.texture;
  if (base_color_texture === undefined && normal_texture === undefined) {
    return materials.fallback;
  }
  const key = `${base_color_texture ?? ""}|${normal_texture ?? ""}`;
  const cached = materials.bind_groups.get(key);
  if (cached !== undefined) return cached;
  const base_color = base_color_texture === undefined
    ? undefined
    : materials.textures.get(base_color_texture);
  const normal = normal_texture === undefined
    ? undefined
    : materials.textures.get(normal_texture);
  const bind_group = create_material_bind_group(
    materials.device,
    materials.layout,
    materials.sampler,
    base_color?.texture ?? materials.fallback_textures.base_color,
    normal?.texture ?? materials.fallback_textures.normal,
  );
  materials.bind_groups.set(key, bind_group);
  return bind_group;
}

interface ResolvedRenderObject {
  readonly source: RenderObject;
  readonly model: Mat4;
  readonly bounds: Aabb;
  readonly layers: number;
}

interface RasterSceneEvaluation {
  readonly selection: RasterSceneSelection;
  readonly visible_set: VisibleSet;
}

interface SceneInstances {
  readonly values: Float32Array;
  readonly batches: readonly SceneBatch[];
}

interface SceneBatch {
  readonly shape: ShapeKey;
  readonly material: CanonicalMaterialRecord;
  readonly first: number;
  readonly count: number;
}

function empty_scene_instances(): SceneInstances {
  return {
    values: new Float32Array(),
    batches: [],
  };
}

function empty_raster_scene_selection(): RasterSceneSelection {
  return Object.freeze({
    submitted: Object.freeze([]),
    rejected: Object.freeze([]),
  });
}

function scene_instances(
  scene: RenderScene,
  selection?: RasterSceneSelection,
): SceneInstances {
  const selected_lods = new Map(
    selection?.submitted.map(({ object_id, lod }) => [object_id, lod]),
  );
  const includes_every_object = selection === undefined;
  const objects = resolved_render_objects(scene).filter(({ source }) =>
    includes_every_object || selected_lods.has(source.id)
  );
  const grouped = new Map<string, ResolvedRenderObject[]>();
  for (const object of objects) {
    const lod = selected_lods.get(object.source.id);
    const key = render_batch_key(object.source, lod);
    const matching = grouped.get(key);
    if (matching === undefined) grouped.set(key, [object]);
    else matching.push(object);
  }
  const values = new Float32Array(objects.length * instance_float_count);
  const batches: SceneBatch[] = [];
  let first = 0;
  for (const matching of grouped.values()) {
    const object = matching[0];
    const source = object.source;
    const lod = selected_lods.get(source.id);
    batches.push({
      shape: render_geometry_key(render_object_geometry(source, lod)),
      material: source.material,
      first,
      count: matching.length,
    });
    for (const [index, resolved] of matching.entries()) {
      const offset = (first + index) * instance_float_count;
      values.set(resolved.model, offset);
      const parameters = resolved.source.material.parameters;
      values.set(
        [
          parameters.base_color.r,
          parameters.base_color.g,
          parameters.base_color.b,
          parameters.perceptual_roughness,
        ],
        offset + 16,
      );
      values.set(
        [
          parameters.emissive.r * parameters.emissive_strength,
          parameters.emissive.g * parameters.emissive_strength,
          parameters.emissive.b * parameters.emissive_strength,
          parameters.metallic,
        ],
        offset + 20,
      );
    }
    first += matching.length;
  }
  return { values, batches };
}

function resolved_render_objects(scene: RenderScene): ResolvedRenderObject[] {
  const resolved = resolve_scene(scene.hierarchy);
  if (resolved.type !== "ready") {
    throw new Error(
      `render scene ${
        JSON.stringify(scene.hierarchy.id)
      } cannot resolve: ${resolved.reason}`,
    );
  }
  const nodes = new Map(
    resolved.scene.nodes.map((node) => [scene_node_key(node.id), node]),
  );
  const meshes = new Map(scene.meshes.map((mesh) => [mesh.id, mesh]));
  const mesh_bounds = scene.mesh_metadata?.bounds ??
    render_mesh_bounds(scene.meshes, scene.mesh_revision);
  return scene.objects.flatMap((source): ResolvedRenderObject[] => {
    const node = nodes.get(scene_node_key(source.node));
    if (node === undefined || !node.world_active) return [];
    return [{
      source,
      model: node.world_transform,
      bounds: transformed_render_bounds(
        render_geometry_bounds(source, meshes, mesh_bounds),
        node.world_transform,
      ),
      layers: node.world_layers,
    }];
  });
}

function render_batch_key(object: RenderObject, lod?: string): string {
  const base_color_texture = object.material.textures.find(({ semantic }) =>
    semantic === "base_color"
  )?.texture;
  const normal_texture = object.material.textures.find(({ semantic }) =>
    semantic === "normal"
  )?.texture;
  return `${render_geometry_key(render_object_geometry(object, lod))}|${
    base_color_texture ?? ""
  }|${normal_texture ?? ""}`;
}

export function select_raster_scene(
  scene: RenderScene,
  view: CameraView,
): RasterSceneSelection {
  validate_render_scene(scene);
  return evaluate_raster_scene(
    scene,
    view,
    new VisibilityPipeline(),
    undefined,
  ).selection;
}

function evaluate_raster_scene(
  scene: RenderScene,
  view: CameraView,
  pipeline: VisibilityPipeline,
  previous: VisibleSet | undefined,
): RasterSceneEvaluation {
  const resolved = resolved_render_objects(scene);
  const object_by_visibility_id = new Map(
    resolved.map((object) => [render_visibility_id(object.source), object]),
  );
  const visible_set = pipeline.evaluate(
    resolved.map((object) =>
      visibility_object({
        id: render_visibility_id(object.source),
        bounds: object.bounds,
        layers: object.layers,
        revision: scene.hierarchy.revision,
        lods: render_visibility_lods(object.source),
        ...(object.source.raster_visibility?.maximum_distance === undefined
          ? {}
          : {
            maximum_distance: object.source.raster_visibility.maximum_distance,
          }),
        ...(object.source.raster_visibility?.minimum_projected_pixels ===
            undefined
          ? {}
          : {
            minimum_projected_pixels:
              object.source.raster_visibility.minimum_projected_pixels,
          }),
      })
    ),
    {
      revision: scene.hierarchy.revision,
      view,
      lod_hysteresis_ratio: 0.1,
      ...(previous === undefined ? {} : { previous }),
    },
  );
  const submitted = visible_set.visible.map(({ id, lod }) => {
    const object = object_by_visibility_id.get(id);
    if (object === undefined) {
      throw new Error(
        `render visibility accepted unknown object ${JSON.stringify(id)}`,
      );
    }
    return Object.freeze({ object_id: object.source.id, lod });
  });
  const rejected = visible_set.rejected.map(({ id, reason }) => {
    const object = object_by_visibility_id.get(id);
    if (object === undefined) {
      throw new Error(
        `render visibility rejected unknown object ${JSON.stringify(id)}`,
      );
    }
    return Object.freeze({ object_id: object.source.id, reason });
  });
  return Object.freeze({
    selection: Object.freeze({
      submitted: Object.freeze(submitted),
      rejected: Object.freeze(rejected),
    }),
    visible_set,
  });
}

function render_visibility_id(object: RenderObject): VisibilityId {
  return object.raster_visibility?.id ?? visibility_id(object.id);
}

function render_visibility_lods(
  object: RenderObject,
): readonly {
  readonly id: string;
  readonly minimum_projected_pixels: number;
}[] {
  return object.raster_visibility?.lods?.map((lod) => ({
    id: lod.id,
    minimum_projected_pixels: lod.minimum_projected_pixels,
  })) ?? [{ id: "source", minimum_projected_pixels: 0 }];
}

function render_object_geometry(
  object: RenderObject,
  lod: string | undefined,
): RenderGeometry {
  const levels = object.raster_visibility?.lods;
  if (levels === undefined || lod === undefined) return object;
  const selected = levels.find((level) => level.id === lod);
  if (selected === undefined) {
    throw new Error(
      `render object ${JSON.stringify(object.id)} omitted selected LOD ${
        JSON.stringify(lod)
      }`,
    );
  }
  return selected.geometry;
}

function render_geometry_key(geometry: RenderGeometry): ShapeKey {
  return geometry.shape === "mesh" ? geometry.mesh : geometry.shape;
}

function render_geometry_bounds(
  geometry: RenderGeometry,
  meshes: ReadonlyMap<RenderMeshId, RenderMesh>,
  mesh_bounds: ReadonlyMap<RenderMeshId, Aabb>,
): Aabb {
  if (geometry.shape !== "mesh") {
    return aabb(vec3(-0.5, -0.5, -0.5), vec3(0.5, 0.5, 0.5));
  }
  const mesh = meshes.get(geometry.mesh);
  if (mesh === undefined) {
    throw new Error(
      `render visibility omitted mesh ${JSON.stringify(geometry.mesh)}`,
    );
  }
  const bounds = mesh_bounds.get(mesh.id);
  if (bounds === undefined) {
    throw new Error(
      `render visibility omitted bounds for mesh ${JSON.stringify(mesh.id)}`,
    );
  }
  return bounds;
}

function render_mesh_bounds(
  meshes: readonly RenderMesh[],
  revision?: number,
): ReadonlyMap<RenderMeshId, Aabb> {
  const cached = revision === undefined
    ? undefined
    : render_mesh_bounds_cache.get(meshes);
  if (cached !== undefined && cached.revision === revision) {
    return cached.bounds;
  }
  const bounds = new Map<RenderMeshId, Aabb>();
  for (const mesh of meshes) {
    let minimum_x = Number.POSITIVE_INFINITY;
    let minimum_y = Number.POSITIVE_INFINITY;
    let minimum_z = Number.POSITIVE_INFINITY;
    let maximum_x = Number.NEGATIVE_INFINITY;
    let maximum_y = Number.NEGATIVE_INFINITY;
    let maximum_z = Number.NEGATIVE_INFINITY;
    for (let offset = 0; offset < mesh.vertices.length; offset += 8) {
      const x = mesh.vertices[offset];
      const y = mesh.vertices[offset + 1];
      const z = mesh.vertices[offset + 2];
      minimum_x = Math.min(minimum_x, x);
      minimum_y = Math.min(minimum_y, y);
      minimum_z = Math.min(minimum_z, z);
      maximum_x = Math.max(maximum_x, x);
      maximum_y = Math.max(maximum_y, y);
      maximum_z = Math.max(maximum_z, z);
    }
    bounds.set(
      mesh.id,
      aabb(
        vec3(minimum_x, minimum_y, minimum_z),
        vec3(maximum_x, maximum_y, maximum_z),
      ),
    );
  }
  if (revision !== undefined) {
    render_mesh_bounds_cache.set(meshes, { bounds, revision });
  }
  return bounds;
}

function transformed_render_bounds(bounds: Aabb, matrix: Mat4): Aabb {
  return aabb_from_points([
    vec3(bounds.minimum.x, bounds.minimum.y, bounds.minimum.z),
    vec3(bounds.minimum.x, bounds.minimum.y, bounds.maximum.z),
    vec3(bounds.minimum.x, bounds.maximum.y, bounds.minimum.z),
    vec3(bounds.minimum.x, bounds.maximum.y, bounds.maximum.z),
    vec3(bounds.maximum.x, bounds.minimum.y, bounds.minimum.z),
    vec3(bounds.maximum.x, bounds.minimum.y, bounds.maximum.z),
    vec3(bounds.maximum.x, bounds.maximum.y, bounds.minimum.z),
    vec3(bounds.maximum.x, bounds.maximum.y, bounds.maximum.z),
  ].map((point) => mat4_transform_affine_point(matrix, point)));
}

function next_raster_temporal_frame(
  previous: RasterTemporalHistory | undefined,
  request: RasterTemporalFrameRequest,
  pending_reset: RasterTemporalResetReason,
): RasterTemporalFramePlan {
  const reset_reasons: RasterTemporalResetReason[] = [];
  if (previous === undefined) {
    reset_reasons.push(pending_reset);
  } else {
    if (previous.target_revision !== request.target_revision) {
      reset_reasons.push("viewport");
    }
    if (previous.camera_signature !== request.camera_signature) {
      reset_reasons.push("camera");
    }
    if (previous.scene_signature !== request.scene_signature) {
      reset_reasons.push("scene");
    }
  }
  const history_index = previous?.history_index === 0 ? 1 : 0;
  const accumulation = reset_reasons.length === 0 ? "continued" : "reset";
  return Object.freeze({
    next_history: Object.freeze({
      camera: request.camera,
      camera_signature: request.camera_signature,
      history_index,
      scene_signature: request.scene_signature,
      target_revision: request.target_revision,
    }),
    result: Object.freeze({
      type: "taa",
      accumulation,
      reset_reasons: Object.freeze(reset_reasons),
    }),
  });
}

function raster_camera_signature(camera: CameraDefinition): string {
  return JSON.stringify({
    id: camera.id,
    pose: camera.pose,
    projection: camera.projection,
    viewport: camera.viewport,
    layers: camera.layers,
  });
}

function raster_scene_signature(
  scene: RenderScene,
  mesh_content_key: string,
): string {
  return JSON.stringify({
    hierarchy: {
      id: scene.hierarchy.id,
      revision: scene.hierarchy.revision,
    },
    objects: scene.objects.map((object) => ({
      id: object.id,
      node: scene_node_key(object.node),
      geometry: render_geometry_key(object),
      material: {
        definition: object.material.definition,
        definition_revision: object.material.definition_revision,
        instance: object.material.instance,
        instance_revision: object.material.instance_revision,
        parameters: object.material.parameters,
        textures: object.material.textures,
      },
      visibility: object.raster_visibility,
    })),
    meshes: mesh_content_key,
    lights: scene.lights,
    environment: scene.environment,
  });
}

function frame_uniform(
  scene: RenderScene,
  view_projection: Mat4,
  light_view_projection: readonly number[],
): Float32Array {
  const directional = scene.lights.find((light) =>
    light.type === "directional"
  );
  const point_lights = scene.lights.filter((light) => light.type === "point");
  const spot_lights = scene.lights.filter((light) => light.type === "spot");
  const values = [
    ...view_projection,
    ...light_view_projection,
    scene.camera.pose.position.x,
    scene.camera.pose.position.y,
    scene.camera.pose.position.z,
    scene.environment.exposure_ev100,
    scene.environment.ambient_light.r,
    scene.environment.ambient_light.g,
    scene.environment.ambient_light.b,
    scene.environment.fog_density,
    scene.environment.fog_color.r,
    scene.environment.fog_color.g,
    scene.environment.fog_color.b,
    1,
    ...(directional === undefined ? [0.4, -1, 0.3, 0] : [
      directional.direction.x,
      directional.direction.y,
      directional.direction.z,
      directional.illuminance_lux / 10_000,
    ]),
    ...(directional === undefined
      ? [0, 0, 0]
      : [directional.color.r, directional.color.g, directional.color.b]),
    0,
  ];
  for (let index = 0; index < maximum_point_lights; index += 1) {
    const light = point_lights[index];
    values.push(
      ...(light === undefined
        ? [0, 0, 0, 0]
        : [light.position.x, light.position.y, light.position.z, light.range]),
    );
  }
  for (let index = 0; index < maximum_point_lights; index += 1) {
    const light = point_lights[index];
    values.push(
      ...(light === undefined ? [0, 0, 0, 0] : [
        light.color.r,
        light.color.g,
        light.color.b,
        light.intensity_candela,
      ]),
    );
  }
  for (let index = 0; index < maximum_spot_lights; index += 1) {
    const light = spot_lights[index];
    values.push(
      ...(light === undefined
        ? [0, 0, 0, 0]
        : [light.position.x, light.position.y, light.position.z, light.range]),
    );
  }
  for (let index = 0; index < maximum_spot_lights; index += 1) {
    const light = spot_lights[index];
    values.push(
      ...(light === undefined ? [0, 0, 0, 0] : [
        light.direction.x,
        light.direction.y,
        light.direction.z,
        Math.cos(light.outer_angle_radians),
      ]),
    );
  }
  for (let index = 0; index < maximum_spot_lights; index += 1) {
    const light = spot_lights[index];
    values.push(
      ...(light === undefined ? [0, 0, 0, 0] : [
        light.color.r,
        light.color.g,
        light.color.b,
        light.intensity_candela,
      ]),
    );
  }
  return new Float32Array(values);
}

function frame_uniform_float_count(): number {
  return 16 + 16 + 4 * 5 + maximum_point_lights * 8 + maximum_spot_lights * 12;
}

function light_matrix(
  light: LightDefinition | undefined,
  camera: CameraDefinition,
): readonly number[] {
  const direction = light?.type === "directional"
    ? light.direction
    : vec3(0.4, -1, 0.3);
  const forward = quat_rotate_vec3(camera.pose.rotation, vec3(0, 0, -1));
  const target = vec3_add(camera.pose.position, vec3_scale(forward, 24));
  const extent = camera.projection.type === "orthographic"
    ? Math.min(180, Math.max(24, camera.projection.vertical_size * 1.3))
    : 32;
  const eye = vec3_add(target, vec3_scale(direction, -extent * 2));
  const view = look_at_view(eye, target, vec3(0, 1, 0));
  const projection = orthographic_projection({
    left: -extent,
    right: extent,
    bottom: -extent,
    top: extent,
    near_plane: 0.1,
    far_plane: extent * 4,
  });
  return mat4_multiply(projection, view);
}

function render_camera_frame(
  camera: CameraDefinition,
  width: number,
  height: number,
  frame_index: number,
  previous?: CameraHistory,
  jitter_scale_pixels = 0,
): CameraFrame {
  const result = build_camera_frame({
    camera,
    surface: { width, height },
    frame_index,
    ...(previous === undefined ? {} : { previous }),
    jitter_scale_pixels,
  });
  if (result.type === "ready") {
    return result.frame;
  }
  throw new Error(
    result.type === "invalid_projection"
      ? `render camera ${result.camera} field ${result.field}: ${result.reason}`
      : `render camera ${result.camera} ${result.operation}: ${result.reason}`,
  );
}

export function pick_render_scene(
  scene: RenderScene,
  point: RenderPickPoint & {
    readonly width: number;
    readonly height: number;
  },
): RenderPickResult {
  if (
    !Number.isSafeInteger(point.width) || point.width <= 0 ||
    !Number.isSafeInteger(point.height) || point.height <= 0
  ) {
    throw new Error(
      `render pick surface ${point.width}x${point.height} must have positive safe-integer dimensions`,
    );
  }
  if (
    !Number.isFinite(point.x) || point.x < 0 || point.x >= point.width ||
    !Number.isFinite(point.y) || point.y < 0 || point.y >= point.height
  ) {
    throw new Error(
      `render pick point ${point.x},${point.y} must be inside ${point.width}x${point.height}`,
    );
  }
  validate_render_scene(scene);
  const view = render_camera_frame(
    scene.camera,
    point.width,
    point.height,
    0,
  ).view;
  const cast = screen_ray(view, point.x, point.y);
  if (cast.type !== "ready") {
    throw new Error(
      `render camera ${cast.camera} ${cast.operation}: ${cast.reason}`,
    );
  }
  const resolved = resolve_scene(scene.hierarchy);
  if (resolved.type !== "ready") {
    throw new Error(
      `render scene ${
        JSON.stringify(scene.hierarchy.id)
      } cannot resolve: ${resolved.reason}`,
    );
  }
  const nodes = new Map(
    resolved.scene.nodes.map((node) => [scene_node_key(node.id), node]),
  );
  const meshes = new Map(scene.meshes.map((mesh) => [mesh.id, mesh]));
  const geometry = build_geometry();
  let closest: Extract<RenderPickResult, { readonly type: "hit" }> | undefined;
  for (const object of scene.objects) {
    const node = nodes.get(scene_node_key(object.node));
    if (node === undefined || !node.world_active) continue;
    const inverse = mat4_inverse(node.world_transform);
    if (!inverse.ok) {
      throw new Error(
        `render object ${
          JSON.stringify(object.id)
        } transform is singular at pivot ${inverse.pivot}`,
      );
    }
    const local_origin = mat4_transform_affine_point(
      inverse.value,
      cast.value.origin,
    );
    const local_direction = vec3_normalize(
      mat4_transform_direction(inverse.value, cast.value.direction),
    );
    let local_distance: number | undefined;
    if (object.shape === "mesh") {
      const mesh = meshes.get(object.mesh);
      if (mesh === undefined) {
        throw new Error(
          `render object ${JSON.stringify(object.id)} selects missing mesh ${
            JSON.stringify(object.mesh)
          }`,
        );
      }
      local_distance = closest_indexed_triangle_hit(
        mesh,
        local_origin,
        local_direction,
      );
    } else {
      local_distance = closest_built_in_triangle_hit(
        geometry,
        object.shape,
        local_origin,
        local_direction,
      );
    }
    if (local_distance === undefined) continue;
    const local_hit = vec3_add(
      local_origin,
      vec3_scale(local_direction, local_distance),
    );
    const world_hit = mat4_transform_affine_point(
      node.world_transform,
      local_hit,
    );
    const distance = vec3_length(vec3_subtract(world_hit, cast.value.origin));
    if (closest !== undefined && closest.distance <= distance) continue;
    closest = { type: "hit", object_id: object.id, distance };
  }
  return closest ?? { type: "miss" };
}

function closest_built_in_triangle_hit(
  geometry: ReturnType<typeof build_geometry>,
  shape: BuiltInGeometry,
  origin: Vec3,
  direction: Vec3,
): number | undefined {
  const range = geometry.shapes.get(shape);
  if (range === undefined) {
    throw new Error(`render renderer omitted built-in ${shape} geometry`);
  }
  let closest: number | undefined;
  const finish = range.first_vertex + range.vertex_count;
  for (let index = range.first_vertex; index < finish; index += 3) {
    const distance = ray_triangle_distance(
      origin,
      direction,
      render_vertex_position(geometry.vertices, index),
      render_vertex_position(geometry.vertices, index + 1),
      render_vertex_position(geometry.vertices, index + 2),
    );
    if (distance === undefined) continue;
    if (closest === undefined || distance < closest) closest = distance;
  }
  return closest;
}

function closest_indexed_triangle_hit(
  mesh: RenderMesh,
  origin: Vec3,
  direction: Vec3,
): number | undefined {
  let closest: number | undefined;
  for (let index = 0; index < mesh.indices.length; index += 3) {
    const distance = ray_triangle_distance(
      origin,
      direction,
      render_vertex_position(mesh.vertices, mesh.indices[index]),
      render_vertex_position(mesh.vertices, mesh.indices[index + 1]),
      render_vertex_position(mesh.vertices, mesh.indices[index + 2]),
    );
    if (distance === undefined) continue;
    if (closest === undefined || distance < closest) closest = distance;
  }
  return closest;
}

function render_vertex_position(
  vertices: ArrayLike<number>,
  index: number,
): Vec3 {
  const offset = index * 8;
  return vec3(vertices[offset], vertices[offset + 1], vertices[offset + 2]);
}

function ray_triangle_distance(
  origin: Vec3,
  direction: Vec3,
  a: Vec3,
  b: Vec3,
  c: Vec3,
): number | undefined {
  const edge_ab = vec3_subtract(b, a);
  const edge_ac = vec3_subtract(c, a);
  const p = vec3_cross(direction, edge_ac);
  const determinant = vec3_dot(edge_ab, p);
  if (Math.abs(determinant) <= 1e-8) return undefined;
  const inverse_determinant = 1 / determinant;
  const origin_offset = vec3_subtract(origin, a);
  const u = vec3_dot(origin_offset, p) * inverse_determinant;
  if (u < 0 || u > 1) return undefined;
  const q = vec3_cross(origin_offset, edge_ab);
  const v = vec3_dot(direction, q) * inverse_determinant;
  if (v < 0 || u + v > 1) return undefined;
  const distance = vec3_dot(edge_ac, q) * inverse_determinant;
  return distance >= 0 ? distance : undefined;
}

function camera_clear_color(camera: CameraDefinition): GPUColorDict {
  if (camera.clear.type === "load") return { r: 0, g: 0, b: 0, a: 1 };
  const [r, g, b, a] = camera.clear.color;
  return { r, g, b, a };
}

export function validate_render_scene(scene: RenderScene): void {
  if (scene.mesh_metadata !== undefined) {
    if (
      typeof scene.mesh_metadata.content_key !== "string" ||
      scene.mesh_metadata.content_key.length === 0
    ) {
      throw new Error(
        `render mesh content key ${
          JSON.stringify(scene.mesh_metadata.content_key)
        } must be non-empty`,
      );
    }
    if (!(scene.mesh_metadata.bounds instanceof Map)) {
      throw new Error("render mesh metadata bounds must be a Map");
    }
    for (const mesh of scene.meshes) {
      const bounds = scene.mesh_metadata.bounds.get(mesh.id);
      if (bounds === undefined) {
        throw new Error(
          `render mesh metadata omits bounds for ${JSON.stringify(mesh.id)}`,
        );
      }
      aabb(bounds.minimum, bounds.maximum);
    }
  }
  if (
    scene.mesh_revision !== undefined &&
    (!Number.isSafeInteger(scene.mesh_revision) || scene.mesh_revision < 0)
  ) {
    throw new Error(
      `render mesh revision ${scene.mesh_revision} must be a nonnegative safe integer`,
    );
  }
  const point_light_count =
    scene.lights.filter((light) => light.type === "point").length;
  const spot_light_count =
    scene.lights.filter((light) => light.type === "spot").length;
  if (point_light_count > maximum_point_lights) {
    throw new Error(
      `render scene has ${point_light_count} point lights; maximum is ${maximum_point_lights}`,
    );
  }
  if (spot_light_count > maximum_spot_lights) {
    throw new Error(
      `render scene has ${spot_light_count} spot lights; maximum is ${maximum_spot_lights}`,
    );
  }
  for (const light of scene.lights) create_light(light);
  const resolved = resolve_scene(scene.hierarchy);
  if (resolved.type !== "ready") {
    throw new Error(
      `render scene ${
        JSON.stringify(scene.hierarchy.id)
      } cannot resolve: ${resolved.reason}`,
    );
  }
  const node_ids = new Set(
    resolved.scene.nodes.map((node) => scene_node_key(node.id)),
  );
  for (
    const [label, value] of [
      ["fog density", scene.environment.fog_density],
      ["exposure", scene.environment.exposure_ev100],
      ["bloom intensity", scene.environment.bloom_intensity],
    ] as const
  ) {
    if (!Number.isFinite(value) || (label !== "exposure" && value < 0)) {
      throw new Error(
        `render ${label} ${JSON.stringify(value)} must be finite${
          label === "exposure" ? "" : " and nonnegative"
        }`,
      );
    }
  }
  const ids = new Set<string>();
  const mesh_ids = new Set<RenderMeshId>();
  const texture_ids = new Set<RenderTextureId>();
  for (const texture of scene.textures) {
    if (texture_ids.has(texture.id)) {
      throw new Error(
        `render scene repeats texture id ${JSON.stringify(texture.id)}`,
      );
    }
    texture_ids.add(texture.id);
    if (texture.source.width <= 0 || texture.source.height <= 0) {
      throw new Error(
        `render texture ${JSON.stringify(texture.id)} has empty dimensions`,
      );
    }
  }
  for (const mesh of scene.meshes) {
    if (mesh_ids.has(mesh.id)) {
      throw new Error(
        `render scene repeats mesh id ${JSON.stringify(mesh.id)}`,
      );
    }
    mesh_ids.add(mesh.id);
    if (mesh.vertices.length === 0 || mesh.vertices.length % 8 !== 0) {
      throw new Error(
        `render mesh ${
          JSON.stringify(mesh.id)
        } has ${mesh.vertices.length} floats; expected positive position-normal-texture vertices`,
      );
    }
    if (mesh.indices.length === 0 || mesh.indices.length % 3 !== 0) {
      throw new Error(
        `render mesh ${
          JSON.stringify(mesh.id)
        } has ${mesh.indices.length} indices; expected a non-empty triangle list`,
      );
    }
    if (!validated_vertex_arrays.has(mesh.vertices)) {
      for (const value of mesh.vertices) {
        if (!Number.isFinite(value)) {
          throw new Error(
            `render mesh ${
              JSON.stringify(mesh.id)
            } contains non-finite vertex ${value}`,
          );
        }
      }
      validated_vertex_arrays.add(mesh.vertices);
    }
    if (validated_index_arrays.has(mesh.indices)) continue;
    const vertex_count = mesh.vertices.length / 8;
    for (const index of mesh.indices) {
      if (index >= vertex_count) {
        throw new Error(
          `render mesh ${JSON.stringify(mesh.id)} index ${index} exceeds ${
            vertex_count - 1
          }`,
        );
      }
    }
    validated_index_arrays.add(mesh.indices);
  }
  for (const object of scene.objects) {
    if (ids.has(object.id)) {
      throw new Error(
        `render scene repeats object id ${JSON.stringify(object.id)}`,
      );
    }
    ids.add(object.id);
    if (!node_ids.has(scene_node_key(object.node))) {
      throw new Error(
        `render object ${
          JSON.stringify(object.id)
        } selects missing scene node ${scene_node_key(object.node)}`,
      );
    }
    if (object.shape === "mesh" && !mesh_ids.has(object.mesh)) {
      throw new Error(
        `render object ${JSON.stringify(object.id)} selects missing mesh ${
          JSON.stringify(object.mesh)
        }`,
      );
    }
    const visibility = object.raster_visibility;
    if (visibility !== undefined) {
      visibility_id(visibility.id);
      for (
        const [label, value] of [
          ["maximum distance", visibility.maximum_distance],
          ["minimum projected pixels", visibility.minimum_projected_pixels],
        ] as const
      ) {
        if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
          throw new Error(
            `render object ${JSON.stringify(object.id)} visibility ${label} ${
              JSON.stringify(value)
            } must be finite and nonnegative`,
          );
        }
      }
      if (visibility.lods !== undefined) {
        if (!Array.isArray(visibility.lods) || visibility.lods.length === 0) {
          throw new Error(
            `render object ${
              JSON.stringify(object.id)
            } visibility LODs must be a non-empty array`,
          );
        }
        const lod_ids = new Set<string>();
        for (const lod of visibility.lods) {
          if (
            typeof lod.id !== "string" || lod.id.trim().length === 0 ||
            lod.id !== lod.id.trim() || lod_ids.has(lod.id)
          ) {
            throw new Error(
              `render object ${
                JSON.stringify(object.id)
              } has invalid or duplicate visibility LOD ${
                JSON.stringify(lod.id)
              }`,
            );
          }
          if (
            !Number.isFinite(lod.minimum_projected_pixels) ||
            lod.minimum_projected_pixels < 0
          ) {
            throw new Error(
              `render object ${JSON.stringify(object.id)} visibility LOD ${
                JSON.stringify(lod.id)
              } threshold ${
                JSON.stringify(lod.minimum_projected_pixels)
              } must be finite and nonnegative`,
            );
          }
          if (
            lod.geometry.shape !== "cube" && lod.geometry.shape !== "plane" &&
            lod.geometry.shape !== "sphere" && lod.geometry.shape !== "mesh"
          ) {
            throw new Error(
              `render object ${JSON.stringify(object.id)} visibility LOD ${
                JSON.stringify(lod.id)
              } selects unsupported geometry ${
                JSON.stringify(lod.geometry.shape)
              }`,
            );
          }
          if (
            lod.geometry.shape === "mesh" &&
            !mesh_ids.has(lod.geometry.mesh)
          ) {
            throw new Error(
              `render object ${JSON.stringify(object.id)} visibility LOD ${
                JSON.stringify(lod.id)
              } selects missing mesh ${JSON.stringify(lod.geometry.mesh)}`,
            );
          }
          lod_ids.add(lod.id);
        }
      }
    }
    for (const binding of object.material.textures) {
      if (binding.semantic !== "base_color" && binding.semantic !== "normal") {
        throw new Error(
          `render object ${
            JSON.stringify(object.id)
          } material texture semantic ${
            JSON.stringify(binding.semantic)
          } is unsupported by the raster path`,
        );
      }
      if (!texture_ids.has(binding.texture)) {
        throw new Error(
          `render object ${
            JSON.stringify(object.id)
          } selects missing ${binding.semantic} texture ${
            JSON.stringify(binding.texture)
          }`,
        );
      }
      if (
        binding.transform.offset.x !== 0 ||
        binding.transform.offset.y !== 0 ||
        binding.transform.scale.x !== 1 ||
        binding.transform.scale.y !== 1 ||
        binding.transform.rotation_radians !== 0 ||
        binding.uv_set !== 0
      ) {
        throw new Error(
          `render object ${
            JSON.stringify(object.id)
          } ${binding.semantic} texture requires the default UV set and transform`,
        );
      }
      const expected_channels = binding.semantic === "base_color"
        ? "r,g,b,a"
        : "r,g,b";
      if (
        binding.channels.join(",") !== expected_channels ||
        (binding.semantic === "normal" && binding.normal_y !== "up") ||
        binding.sampler.minification !== "linear" ||
        binding.sampler.magnification !== "linear" ||
        binding.sampler.mipmap !== "linear" ||
        binding.sampler.wrap_u !== "repeat" ||
        binding.sampler.wrap_v !== "repeat" ||
        binding.sampler.anisotropy !== 8
      ) {
        throw new Error(
          `render object ${
            JSON.stringify(object.id)
          } ${binding.semantic} texture selects unsupported sampling`,
        );
      }
    }
    for (
      const [label, value] of [
        [
          "roughness",
          object.material.parameters.perceptual_roughness,
        ],
        ["metallic", object.material.parameters.metallic],
      ] as const
    ) {
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(
          `render object ${
            JSON.stringify(object.id)
          } ${label} ${value} must be in [0, 1]`,
        );
      }
    }
  }
}

function create_buffer(
  device: GPUDevice,
  values: Float32Array,
  usage: number,
): GPUBuffer {
  const buffer = device.createBuffer({
    size: Math.max(4, values.byteLength),
    usage,
    mappedAtCreation: true,
  });
  new Float32Array(buffer.getMappedRange()).set(values);
  buffer.unmap();
  return buffer;
}

function create_instance_allocation(device: GPUDevice): InstanceAllocation {
  return {
    buffer: device.createBuffer({
      size: instance_float_count * 4,
      usage: gpu_buffer_usage.vertex | gpu_buffer_usage.copy_dst,
    }),
    capacity: 1,
  };
}

function upload_scene_instances(
  device: GPUDevice,
  current: InstanceAllocation,
  instances: SceneInstances,
): InstanceAllocation {
  const instance_count = instances.values.length / instance_float_count;
  let allocation = current;
  if (instance_count > current.capacity) {
    current.buffer.destroy();
    const capacity = next_power_of_two(instance_count);
    allocation = {
      buffer: device.createBuffer({
        size: capacity * instance_float_count * 4,
        usage: gpu_buffer_usage.vertex | gpu_buffer_usage.copy_dst,
      }),
      capacity,
    };
  }
  if (instances.values.length > 0) {
    device.queue.writeBuffer(allocation.buffer, 0, instances.values);
  }
  return allocation;
}

function create_fallback_material_textures(device: GPUDevice): {
  readonly base_color: GPUTexture;
  readonly normal: GPUTexture;
} {
  return {
    base_color: create_solid_texture(
      device,
      "rgba8unorm-srgb",
      new Uint8Array([255, 255, 255, 255]),
    ),
    normal: create_solid_texture(
      device,
      "rgba8unorm",
      new Uint8Array([128, 128, 255, 255]),
    ),
  };
}

function create_solid_texture(
  device: GPUDevice,
  format: GPUTextureFormat,
  color: Uint8Array,
): GPUTexture {
  const texture = device.createTexture({
    size: [1, 1],
    format,
    usage: gpu_texture_usage.copy_dst | gpu_texture_usage.texture_binding,
  });
  device.queue.writeTexture(
    { texture },
    color,
    { bytesPerRow: 4 },
    [1, 1],
  );
  return texture;
}

function create_material_bind_group(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  sampler: GPUSampler,
  base_color: GPUTexture,
  normal: GPUTexture,
): GPUBindGroup {
  return device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: base_color.createView() },
      { binding: 1, resource: sampler },
      { binding: 2, resource: normal.createView() },
      { binding: 3, resource: sampler },
    ],
  });
}

function is_gpu_canvas_context(
  context: RenderingContext | null,
): context is GPUCanvasContext {
  return context !== null &&
    "configure" in context && typeof context.configure === "function" &&
    "unconfigure" in context && typeof context.unconfigure === "function" &&
    "getCurrentTexture" in context &&
    typeof context.getCurrentTexture === "function";
}

function next_power_of_two(value: number): number {
  let capacity = 1;
  while (capacity < value) capacity *= 2;
  return capacity;
}

function build_geometry(): {
  readonly vertices: Float32Array;
  readonly shapes: ReadonlyMap<BuiltInGeometry, ShapeGeometry>;
} {
  const cube = append_zero_texture_coordinates(cube_vertices());
  const plane = append_zero_texture_coordinates(plane_vertices());
  const sphere = append_zero_texture_coordinates(sphere_vertices(20, 12));
  return {
    vertices: new Float32Array([...cube, ...plane, ...sphere]),
    shapes: new Map([
      ["cube", { first_vertex: 0, vertex_count: cube.length / 8 }],
      ["plane", {
        first_vertex: cube.length / 8,
        vertex_count: plane.length / 8,
      }],
      ["sphere", {
        first_vertex: (cube.length + plane.length) / 8,
        vertex_count: sphere.length / 8,
      }],
    ]),
  };
}

function create_imported_geometry_set(
  device: GPUDevice,
  meshes: readonly RenderMesh[],
  content_key = render_mesh_content_key(meshes),
): ImportedGeometrySet {
  const vertex_float_count = meshes.reduce(
    (count, mesh) => count + mesh.vertices.length,
    0,
  );
  const index_count = meshes.reduce(
    (count, mesh) => count + mesh.indices.length,
    0,
  );
  const vertex_buffer = device.createBuffer({
    size: Math.max(4, vertex_float_count * 4),
    usage: gpu_buffer_usage.vertex,
    mappedAtCreation: true,
  });
  const index_buffer = device.createBuffer({
    size: Math.max(4, index_count * 4),
    usage: gpu_buffer_usage.index,
    mappedAtCreation: true,
  });
  const vertices = new Float32Array(vertex_buffer.getMappedRange());
  const indices = new Uint32Array(index_buffer.getMappedRange());
  const ranges = new Map<RenderMeshId, ImportedGeometry>();
  let vertex_offset = 0;
  let index_offset = 0;
  for (const mesh of meshes) {
    vertices.set(mesh.vertices, vertex_offset);
    indices.set(mesh.indices, index_offset);
    ranges.set(mesh.id, {
      base_vertex: vertex_offset / 8,
      first_index: index_offset,
      index_count: mesh.indices.length,
    });
    vertex_offset += mesh.vertices.length;
    index_offset += mesh.indices.length;
  }
  vertex_buffer.unmap();
  index_buffer.unmap();
  return {
    content_key,
    index_buffer,
    ranges,
    vertex_buffer,
  };
}

export function render_mesh_metadata(
  meshes: readonly RenderMesh[],
): RenderMeshMetadata {
  return Object.freeze({
    bounds: render_mesh_bounds(meshes),
    content_key: render_mesh_content_key(meshes),
  });
}

function render_mesh_content_key(
  meshes: readonly RenderMesh[],
  revision?: number,
): string {
  const cached = revision === undefined
    ? undefined
    : render_mesh_content_keys.get(meshes);
  if (cached !== undefined && cached.revision === revision) {
    return cached.content_key;
  }
  let primary = 0x811c9dc5;
  let secondary = 0x9e3779b9;
  const mix_word = (word: number): void => {
    primary = Math.imul(primary ^ word, 0x01000193);
    secondary = Math.imul(secondary ^ word, 0x85ebca6b);
    secondary ^= secondary >>> 13;
  };
  mix_word(meshes.length);
  const encoder = new TextEncoder();
  for (const mesh of meshes) {
    const id = encoder.encode(mesh.id);
    mix_word(id.length);
    for (const byte of id) mix_word(byte);
    mix_word(mesh.vertices.length);
    const vertex_words = new Uint32Array(
      mesh.vertices.buffer,
      mesh.vertices.byteOffset,
      mesh.vertices.length,
    );
    for (const word of vertex_words) mix_word(word);
    mix_word(mesh.indices.length);
    for (const index of mesh.indices) mix_word(index);
  }
  const content_key = `mesh-v1:${
    (primary >>> 0).toString(16).padStart(8, "0")
  }:${(secondary >>> 0).toString(16).padStart(8, "0")}`;
  if (revision !== undefined) {
    render_mesh_content_keys.set(meshes, { content_key, revision });
  }
  return content_key;
}

function synchronize_imported_textures(
  device: GPUDevice,
  current: Map<RenderTextureId, ImportedTexture>,
  mipmap_pipelines: Readonly<
    Record<RenderTexture["color_space"], GPURenderPipeline>
  >,
  mipmap_sampler: GPUSampler,
  textures: readonly RenderTexture[],
): void {
  const retained = new Set<RenderTextureId>();
  let commands: GPUCommandEncoder | undefined;
  for (const texture of textures) {
    retained.add(texture.id);
    const existing = current.get(texture.id);
    if (
      existing?.source === texture.source &&
      existing.color_space === texture.color_space
    ) continue;
    existing?.texture.destroy();
    const mip_level_count = texture_mip_level_count(
      texture.source.width,
      texture.source.height,
    );
    const gpu_texture = device.createTexture({
      size: [texture.source.width, texture.source.height],
      mipLevelCount: mip_level_count,
      format: texture.color_space === "srgb" ? "rgba8unorm-srgb" : "rgba8unorm",
      usage: gpu_texture_usage.copy_dst | gpu_texture_usage.render_attachment |
        gpu_texture_usage.texture_binding,
    });
    device.queue.copyExternalImageToTexture(
      { source: texture.source },
      { texture: gpu_texture },
      [texture.source.width, texture.source.height],
    );
    if (mip_level_count > 1) {
      commands ??= device.createCommandEncoder();
      encode_texture_mip_levels(
        device,
        commands,
        gpu_texture,
        mip_level_count,
        mipmap_pipelines[texture.color_space],
        mipmap_sampler,
      );
    }
    current.set(texture.id, {
      color_space: texture.color_space,
      source: texture.source,
      texture: gpu_texture,
    });
  }
  if (commands !== undefined) device.queue.submit([commands.finish()]);
  for (const [id, texture] of current) {
    if (retained.has(id)) continue;
    texture.texture.destroy();
    current.delete(id);
  }
}

function create_mipmap_pipeline(
  device: GPUDevice,
  module: GPUShaderModule,
  format: GPUTextureFormat,
): Promise<GPURenderPipeline> {
  return device.createRenderPipelineAsync({
    layout: "auto",
    vertex: { module, entryPoint: "vertex_main" },
    fragment: {
      module,
      entryPoint: "fragment_main",
      targets: [{ format }],
    },
    primitive: { topology: "triangle-list" },
  });
}

function same_render_textures(
  current: readonly RenderTexture[],
  next: readonly RenderTexture[],
): boolean {
  if (current.length !== next.length) return false;
  return current.every((texture, index) => {
    const candidate = next[index];
    return texture.id === candidate.id &&
      texture.color_space === candidate.color_space &&
      texture.source === candidate.source;
  });
}

function texture_mip_level_count(width: number, height: number): number {
  return Math.floor(Math.log2(Math.max(width, height))) + 1;
}

function encode_texture_mip_levels(
  device: GPUDevice,
  commands: GPUCommandEncoder,
  texture: GPUTexture,
  mip_level_count: number,
  pipeline: GPURenderPipeline,
  sampler: GPUSampler,
): void {
  for (let mip_level = 1; mip_level < mip_level_count; mip_level += 1) {
    const bind_group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        {
          binding: 0,
          resource: texture.createView({
            baseMipLevel: mip_level - 1,
            mipLevelCount: 1,
          }),
        },
        { binding: 1, resource: sampler },
      ],
    });
    const pass = commands.beginRenderPass({
      colorAttachments: [{
        view: texture.createView({
          baseMipLevel: mip_level,
          mipLevelCount: 1,
        }),
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind_group);
    pass.draw(3);
    pass.end();
  }
}

function append_zero_texture_coordinates(
  position_normal_vertices: readonly number[],
): readonly number[] {
  const vertices: number[] = [];
  for (let offset = 0; offset < position_normal_vertices.length; offset += 6) {
    vertices.push(...position_normal_vertices.slice(offset, offset + 6), 0, 0);
  }
  return vertices;
}

function is_built_in_shape(shape: ShapeKey): shape is BuiltInGeometry {
  return shape === "cube" || shape === "plane" || shape === "sphere";
}

function plane_vertices(): readonly number[] {
  return [
    -0.5,
    0,
    -0.5,
    0,
    1,
    0,
    0.5,
    0,
    0.5,
    0,
    1,
    0,
    0.5,
    0,
    -0.5,
    0,
    1,
    0,
    -0.5,
    0,
    -0.5,
    0,
    1,
    0,
    -0.5,
    0,
    0.5,
    0,
    1,
    0,
    0.5,
    0,
    0.5,
    0,
    1,
    0,
  ];
}

function cube_vertices(): readonly number[] {
  const faces = [
    [[0, 0, 1], [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]],
    [[0, 0, -1], [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]]],
    [[1, 0, 0], [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]]],
    [[-1, 0, 0], [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]]],
    [[0, 1, 0], [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]]],
    [[0, -1, 0], [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]]],
  ] as const;
  const vertices: number[] = [];
  for (const [normal, corners] of faces) {
    for (const index of [0, 1, 2, 0, 2, 3]) {
      const corner = corners[index]!;
      vertices.push(
        corner[0] * 0.5,
        corner[1] * 0.5,
        corner[2] * 0.5,
        ...normal,
      );
    }
  }
  return vertices;
}

function sphere_vertices(columns: number, rows: number): readonly number[] {
  const vertices: number[] = [];
  const point = (column: number, row: number): RenderVector => {
    const longitude = column / columns * Math.PI * 2;
    const latitude = row / rows * Math.PI;
    return [
      Math.sin(latitude) * Math.cos(longitude) * 0.5,
      Math.cos(latitude) * 0.5,
      Math.sin(latitude) * Math.sin(longitude) * 0.5,
    ];
  };
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const a = point(column, row);
      const b = point(column + 1, row);
      const c = point(column + 1, row + 1);
      const d = point(column, row + 1);
      for (const vertex of [a, b, c, a, c, d]) {
        const normal: RenderVector = [
          vertex[0] * 2,
          vertex[1] * 2,
          vertex[2] * 2,
        ];
        vertices.push(...vertex, ...normal);
      }
    }
  }
  return vertices;
}
