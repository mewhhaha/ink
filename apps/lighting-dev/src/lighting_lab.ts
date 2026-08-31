import type { StaticGltfScene } from "@ink/assets/prepared_scene.ts";
import {
  create_renderer,
  type Renderer,
  type RenderFrameResult,
  type RenderScene,
  type RenderTexture,
} from "@ink/rendering/renderer.ts";
import { cornell_scene } from "./cornell_scene.ts";
import { DebugCamera } from "./debug_camera.ts";
import { LightingReferenceAssets } from "./reference_assets.ts";
import {
  type FogMaterialResponse,
  lighting_scene,
  type LightingReference,
  type LightingReferenceModel,
  type LightingSettings,
  prepare_lighting_reference,
  type PreparedLightingReference,
  reference_presentations,
  reference_texture_id,
  type ReferenceNormalResponse,
  type ReferenceTextureUsage,
} from "./scene.ts";
import {
  constrain_lighting_technique,
  lighting_render_technique,
  lighting_technique_preferences,
  type LightingPathTracingQuality,
  type LightingTechniquePreferences,
  type LightingTechniqueSelection,
  select_lighting_technique,
  set_lighting_path_samples,
} from "./technique.ts";

export interface LightingLabConfiguration {
  readonly fog_material_response: FogMaterialResponse;
  readonly initial_reference: LightingReference;
  readonly path_tracing_quality: LightingPathTracingQuality;
  readonly reference_normal_response: ReferenceNormalResponse;
}

export type LightingFrameEvidence =
  | { readonly type: "pending" }
  | RenderFrameResult;
export type LightingRendererStatus =
  | { readonly type: "starting" }
  | Renderer["status"];

interface LightingLabSnapshotBase {
  readonly adapter: string;
  readonly center_pick: "pending" | "miss" | string;
  readonly center_pick_samples: number;
  readonly frame: LightingFrameEvidence;
  readonly move_speed: number;
  readonly reference: LightingReference;
  readonly renderer_status: LightingRendererStatus;
  readonly settings: LightingSettings;
  readonly technique: LightingTechniquePreferences;
  readonly validation_error_count: number;
}

export type LightingLabSnapshot =
  & LightingLabSnapshotBase
  & (
    | { readonly kind: "loading" }
    | {
      readonly kind: "ready";
      readonly load_milliseconds: number;
      readonly pointer_locked: boolean;
      readonly source_mesh_count: number;
      readonly triangle_count: number;
      readonly surface_count: number;
    }
    | { readonly kind: "failed"; readonly message: string }
  );

interface LoadedReference {
  readonly load_milliseconds: number;
  readonly model: LightingReferenceModel;
}

export class LightingLab {
  readonly #camera: DebugCamera;
  readonly #canvas: HTMLCanvasElement;
  readonly #fog_material_response: FogMaterialResponse;
  readonly #listeners = new Set<() => void>();
  readonly #loaded = new Map<
    PreparedLightingReference,
    Promise<LoadedReference>
  >();
  readonly #reference_assets: LightingReferenceAssets;
  readonly #reference_normal_response: ReferenceNormalResponse;
  readonly #renderer: Renderer;
  #center_pick_samples = 0;
  #cornell: RenderScene | undefined;
  #disposed = false;
  #frame = 0;
  #last_pick_accumulated_samples = 0;
  #last_frame_time = performance.now();
  #model: LightingReferenceModel | undefined;
  #selection_sequence = 0;
  #settings: LightingSettings;
  #snapshot: LightingLabSnapshot;
  #started = performance.now();
  #technique: LightingTechniquePreferences;

  private constructor(
    canvas: HTMLCanvasElement,
    renderer: Renderer,
    reference_assets: LightingReferenceAssets,
    configuration: LightingLabConfiguration,
  ) {
    this.#canvas = canvas;
    this.#renderer = renderer;
    this.#reference_assets = reference_assets;
    this.#reference_normal_response = configuration.reference_normal_response;
    this.#fog_material_response = configuration.fog_material_response;
    const presentation =
      reference_presentations[configuration.initial_reference];
    this.#technique = lighting_technique_preferences(
      presentation.technique_support,
      "raster",
      configuration.path_tracing_quality,
    );
    this.#settings = presentation.settings;
    this.#camera = new DebugCamera(
      canvas,
      presentation.camera,
      presentation.camera_target,
      presentation.move_speed,
      (move_speed) => this.#replace_common_snapshot({ move_speed }),
    );
    this.#snapshot = {
      ...this.#common_snapshot(
        configuration.initial_reference,
        presentation.settings,
        presentation.move_speed,
      ),
      kind: "loading",
    };
  }

  static async create(
    canvas: HTMLCanvasElement,
    configuration: LightingLabConfiguration,
  ): Promise<LightingLab> {
    const reference_assets = await LightingReferenceAssets.create();
    const renderer = await create_renderer({
      canvas,
      technique: lighting_render_technique(
        lighting_technique_preferences(
          reference_presentations[configuration.initial_reference]
            .technique_support,
          "raster",
          configuration.path_tracing_quality,
        ),
      ),
    });
    const lab = new LightingLab(
      canvas,
      renderer,
      reference_assets,
      configuration,
    );
    await lab.select_reference(configuration.initial_reference);
    lab.#frame = requestAnimationFrame((now) => lab.#draw(now));
    return lab;
  }

  readonly subscribe = (listener: () => void): () => void => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly snapshot = (): LightingLabSnapshot => this.#snapshot;

  async select_reference(reference: LightingReference): Promise<void> {
    if (this.#disposed) throw new Error("lighting lab is disposed");
    const selection = ++this.#selection_sequence;
    const presentation = reference_presentations[reference];
    const previous_technique = this.#technique;
    this.#technique = constrain_lighting_technique(
      previous_technique,
      presentation.technique_support,
    );
    if (previous_technique.selection !== this.#technique.selection) {
      this.#renderer.set_technique(
        lighting_render_technique(this.#technique),
      );
    }
    this.#snapshot = {
      ...this.#common_snapshot(
        reference,
        presentation.settings,
        presentation.move_speed,
      ),
      kind: "loading",
    };
    this.#emit();
    this.#settings = presentation.settings;
    this.#camera.reset(
      presentation.camera,
      presentation.camera_target,
      presentation.move_speed,
    );
    this.#reset_frame_evidence();
    this.#started = performance.now();
    if (reference === "cornell") {
      this.#model = undefined;
      this.#cornell = cornell_scene({ settings: this.#settings });
      this.#snapshot = {
        ...this.#common_snapshot(
          reference,
          this.#settings,
          this.#camera.move_speed,
        ),
        kind: "ready",
        load_milliseconds: 0,
        pointer_locked: this.#camera.pointer_locked,
        source_mesh_count: this.#cornell.meshes.length,
        surface_count: this.#cornell.objects.length,
        triangle_count: this.#cornell.meshes.reduce(
          (count, mesh) => count + mesh.indices.length / 3,
          0,
        ),
      };
      this.#emit();
      return;
    }
    try {
      const loaded = await this.#load(reference);
      if (selection !== this.#selection_sequence || this.#disposed) return;
      this.#model = loaded.model;
      this.#cornell = undefined;
      this.#snapshot = {
        ...this.#common_snapshot(
          reference,
          this.#settings,
          this.#camera.move_speed,
        ),
        kind: "ready",
        load_milliseconds: loaded.load_milliseconds,
        pointer_locked: this.#camera.pointer_locked,
        source_mesh_count: loaded.model.source_mesh_count,
        surface_count: loaded.model.meshes.length,
        triangle_count: loaded.model.triangle_count,
      };
      this.#emit();
    } catch (error) {
      if (selection !== this.#selection_sequence || this.#disposed) return;
      this.#snapshot = {
        ...this.#common_snapshot(
          reference,
          presentation.settings,
          presentation.move_speed,
        ),
        kind: "failed",
        message: error instanceof Error ? error.message : String(error),
      };
      this.#emit();
    }
  }

  set_setting(setting: keyof LightingSettings, value: number): void {
    if (!Number.isFinite(value)) {
      throw new Error(`lighting ${setting} ${value} must be finite`);
    }
    this.#settings = { ...this.#settings, [setting]: value };
    if (this.#snapshot.reference === "cornell") {
      this.#cornell = cornell_scene({ settings: this.#settings });
    }
    this.#replace_common_snapshot({ settings: this.#settings });
  }

  select_technique(selection: LightingTechniqueSelection): void {
    const selected = select_lighting_technique(this.#technique, selection);
    if (selected === this.#technique) return;
    this.#technique = selected;
    this.#renderer.set_technique(
      lighting_render_technique(this.#technique),
    );
    this.#reset_frame_evidence();
    this.#replace_common_snapshot({
      center_pick: "pending",
      center_pick_samples: 0,
      frame: { type: "pending" },
      technique: this.#technique,
    });
  }

  set_path_samples(path_samples_per_frame: number): void {
    this.#technique = set_lighting_path_samples(
      this.#technique,
      path_samples_per_frame,
    );
    if (this.#technique.selection === "path_traced") {
      this.#renderer.set_technique(
        lighting_render_technique(this.#technique),
      );
      this.#reset_frame_evidence();
    }
    this.#replace_common_snapshot({
      center_pick: this.#technique.selection === "path_traced"
        ? "pending"
        : this.#snapshot.center_pick,
      center_pick_samples: this.#technique.selection === "path_traced"
        ? 0
        : this.#snapshot.center_pick_samples,
      frame: this.#technique.selection === "path_traced"
        ? { type: "pending" }
        : this.#snapshot.frame,
      technique: this.#technique,
    });
  }

  set_move_speed(speed: number): void {
    this.#camera.set_move_speed(speed);
  }

  reset_camera(): void {
    const presentation = reference_presentations[this.#snapshot.reference];
    this.#camera.reset(
      presentation.camera,
      presentation.camera_target,
      presentation.move_speed,
    );
  }

  async capture_pointer(): Promise<void> {
    await this.#camera.capture_pointer();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    cancelAnimationFrame(this.#frame);
    this.#camera.dispose();
    this.#renderer.dispose();
    const sources = new Set<ImageBitmap>();
    for (const loaded of this.#loaded.values()) {
      void loaded.then(
        ({ model }) => {
          for (const { source } of model.textures) sources.add(source);
          for (const source of sources) source.close();
        },
        () => undefined,
      );
    }
    this.#listeners.clear();
  }

  #load(reference: PreparedLightingReference): Promise<LoadedReference> {
    const cached = this.#loaded.get(reference);
    if (cached !== undefined) return cached;
    const loading = load_reference(reference, this.#reference_assets);
    this.#loaded.set(reference, loading);
    void loading.catch(() => this.#loaded.delete(reference));
    return loading;
  }

  #draw(now: number): void {
    if (this.#disposed) return;
    try {
      const delta_seconds = (now - this.#last_frame_time) / 1_000;
      this.#last_frame_time = now;
      const camera = this.#camera.update(delta_seconds);
      const scene = this.#render_scene(camera, now);
      if (scene !== undefined) {
        const frame = this.#renderer.render(scene);
        this.#publish_frame(scene, frame);
      }
      this.#frame = requestAnimationFrame((next) => this.#draw(next));
    } catch (error) {
      this.#snapshot = {
        ...this.#common_snapshot(
          this.#snapshot.reference,
          this.#settings,
          this.#camera.move_speed,
        ),
        kind: "failed",
        message: error instanceof Error ? error.message : String(error),
      };
      this.#emit();
    }
  }

  #render_scene(
    camera: RenderScene["camera"],
    now: number,
  ): RenderScene | undefined {
    if (this.#snapshot.reference === "cornell") {
      return this.#cornell === undefined
        ? undefined
        : { ...this.#cornell, camera };
    }
    if (this.#model === undefined) return undefined;
    const elapsed_seconds = this.#technique.selection === "raster"
      ? (now - this.#started) / 1_000
      : 0;
    return lighting_scene(
      elapsed_seconds,
      this.#model,
      camera,
      this.#settings,
      this.#fog_material_response,
      this.#reference_normal_response,
    );
  }

  #publish_frame(scene: RenderScene, frame: RenderFrameResult): void {
    if (this.#snapshot.kind !== "ready") return;
    let center_pick = this.#snapshot.center_pick;
    const should_sample_pick = (this.#snapshot.reference === "cornell" ||
      this.#snapshot.reference === "fog-room") &&
      frame.type === "path_traced" && frame.accumulated_samples >= 64 &&
      frame.accumulated_samples > this.#last_pick_accumulated_samples;
    if (should_sample_pick) {
      const pick = this.#renderer.pick(scene, {
        x: Math.floor(this.#canvas.width / 2),
        y: Math.floor(this.#canvas.height / 2),
      });
      center_pick = pick.type === "hit" ? pick.object_id : "miss";
      this.#center_pick_samples += 1;
      this.#last_pick_accumulated_samples = frame.accumulated_samples;
    }
    const renderer_status = this.#renderer.status;
    const validation_error_count = this.#renderer.validation_error_count;
    const pointer_locked = this.#camera.pointer_locked;
    if (
      frame_evidence_equal(this.#snapshot.frame, frame) &&
      renderer_status_equal(this.#snapshot.renderer_status, renderer_status) &&
      this.#snapshot.validation_error_count === validation_error_count &&
      this.#snapshot.pointer_locked === pointer_locked &&
      this.#snapshot.center_pick === center_pick &&
      this.#snapshot.center_pick_samples === this.#center_pick_samples
    ) return;
    this.#snapshot = {
      ...this.#snapshot,
      center_pick,
      center_pick_samples: this.#center_pick_samples,
      frame,
      pointer_locked,
      renderer_status,
      validation_error_count,
    };
    this.#emit();
  }

  #replace_common_snapshot(change: {
    readonly center_pick?: LightingLabSnapshotBase["center_pick"];
    readonly center_pick_samples?: number;
    readonly frame?: LightingFrameEvidence;
    readonly move_speed?: number;
    readonly settings?: LightingSettings;
    readonly technique?: LightingTechniquePreferences;
  }): void {
    this.#snapshot = {
      ...this.#snapshot,
      center_pick: change.center_pick ?? this.#snapshot.center_pick,
      center_pick_samples: change.center_pick_samples ??
        this.#snapshot.center_pick_samples,
      frame: change.frame ?? this.#snapshot.frame,
      move_speed: change.move_speed ?? this.#snapshot.move_speed,
      settings: change.settings ?? this.#snapshot.settings,
      technique: change.technique ?? this.#snapshot.technique,
    };
    this.#emit();
  }

  #common_snapshot(
    reference: LightingReference,
    settings: LightingSettings,
    move_speed: number,
  ): LightingLabSnapshotBase {
    return {
      adapter: this.#renderer.adapter_description,
      center_pick: "pending",
      center_pick_samples: this.#center_pick_samples,
      frame: { type: "pending" },
      move_speed,
      reference,
      renderer_status: this.#renderer.status,
      settings,
      technique: this.#technique,
      validation_error_count: this.#renderer.validation_error_count,
    };
  }

  #reset_frame_evidence(): void {
    this.#center_pick_samples = 0;
    this.#last_pick_accumulated_samples = 0;
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

async function load_reference(
  reference: PreparedLightingReference,
  reference_assets: LightingReferenceAssets,
): Promise<LoadedReference> {
  const started = performance.now();
  const { scene } = await reference_assets.load(reference);
  const textures = await decode_reference_textures(scene);
  try {
    return {
      load_milliseconds: performance.now() - started,
      model: prepare_lighting_reference(scene, reference, textures),
    };
  } catch (error) {
    const sources = new Set(textures.map(({ source }) => source));
    for (const source of sources) source.close();
    throw error;
  }
}

function frame_evidence_equal(
  current: LightingFrameEvidence,
  next: RenderFrameResult,
): boolean {
  if (current.type !== next.type) return false;
  if (current.type === "raster" && next.type === "raster") {
    return current.reason === next.reason &&
      current.path_tracing_failure === next.path_tracing_failure;
  }
  if (current.type === "path_traced" && next.type === "path_traced") {
    return current.accumulated_samples === next.accumulated_samples &&
      current.accumulation === next.accumulation &&
      current.acceleration.type === next.acceleration.type &&
      current.reset_reasons.join("\0") === next.reset_reasons.join("\0");
  }
  return false;
}

function renderer_status_equal(
  current: LightingRendererStatus,
  next: Renderer["status"],
): boolean {
  if (current.type === "starting") return false;
  if (current.type !== next.type) return false;
  if (current.type === "ready" && next.type === "ready") return true;
  return current.type !== "ready" && next.type !== "ready" &&
    current.reason === next.reason;
}

async function decode_reference_textures(
  scene: StaticGltfScene,
): Promise<RenderTexture[]> {
  const usages = texture_usages(scene);
  const requested = scene.textures.filter(({ id }) => usages.has(id));
  const decoded = await Promise.allSettled(requested.map(async (texture) => ({
    source: await createImageBitmap(
      new Blob([texture.bytes.slice().buffer], { type: texture.mime_type }),
    ),
    texture,
  })));
  const failure = decoded.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") {
    for (const result of decoded) {
      if (result.status === "fulfilled") result.value.source.close();
    }
    throw failure.reason;
  }
  const textures: RenderTexture[] = [];
  for (const result of decoded) {
    if (result.status !== "fulfilled") continue;
    for (const usage of usages.get(result.value.texture.id) ?? []) {
      textures.push({
        color_space: usage === "base-color" ? "srgb" : "linear",
        id: reference_texture_id(result.value.texture.id, usage),
        source: result.value.source,
      });
    }
  }
  return textures;
}

function texture_usages(
  scene: StaticGltfScene,
): ReadonlyMap<string, ReadonlySet<ReferenceTextureUsage>> {
  const usages = new Map<string, Set<ReferenceTextureUsage>>();
  for (const { material } of scene.meshes) {
    add_texture_usage(usages, material.base_color_texture, "base-color");
    add_texture_usage(usages, material.normal_texture, "normal");
  }
  return usages;
}

function add_texture_usage(
  usages: Map<string, Set<ReferenceTextureUsage>>,
  texture: string | undefined,
  usage: ReferenceTextureUsage,
): void {
  if (texture === undefined) return;
  const current = usages.get(texture);
  if (current === undefined) usages.set(texture, new Set([usage]));
  else current.add(usage);
}
