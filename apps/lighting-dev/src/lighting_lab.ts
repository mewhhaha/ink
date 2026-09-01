import {
  create_renderer,
  type Renderer,
  type RenderFrameResult,
  type RenderOutputMode,
  type RenderScene,
} from "@ink/rendering/renderer.ts";
import { cornell_scene } from "./cornell_scene.ts";
import { DebugCamera } from "./debug_camera.ts";
import { LightingReferenceLoader } from "./reference_loader.ts";
import type { LoadedReference } from "./reference_worker_protocol.ts";
import {
  type FogMaterialResponse,
  lighting_scene,
  type LightingReference,
  type LightingReferenceModel,
  type LightingSettings,
  type PreparedLightingReference,
  reference_presentations,
  type ReferenceNormalResponse,
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
  readonly hdr_output: Renderer["hdr_output"];
  readonly move_speed: number;
  readonly output_mode: RenderOutputMode;
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
      readonly source_materials: "embedded" | "procedural" | "upstream-omitted";
      readonly source_mesh_count: number;
      readonly triangle_count: number;
      readonly surface_count: number;
    }
    | { readonly kind: "failed"; readonly message: string }
  );

export class LightingLab {
  readonly #camera: DebugCamera;
  readonly #canvas: HTMLCanvasElement;
  readonly #fog_material_response: FogMaterialResponse;
  readonly #listeners = new Set<() => void>();
  readonly #loaded = new Map<
    PreparedLightingReference,
    Promise<LoadedReference>
  >();
  readonly #reference_loader: LightingReferenceLoader;
  readonly #reference_normal_response: ReferenceNormalResponse;
  readonly #renderer: Renderer;
  #center_pick_samples = 0;
  #cornell: RenderScene | undefined;
  #disposed = false;
  #displayed_reference: LightingReference | undefined;
  #frame = 0;
  #last_pick_accumulated_samples = 0;
  #last_frame_time = performance.now();
  #model: LightingReferenceModel | undefined;
  #reference_scene: RenderScene | undefined;
  #selection_sequence = 0;
  #settings: LightingSettings;
  #snapshot: LightingLabSnapshot;
  #started = performance.now();
  #technique: LightingTechniquePreferences;

  private constructor(
    canvas: HTMLCanvasElement,
    renderer: Renderer,
    reference_loader: LightingReferenceLoader,
    configuration: LightingLabConfiguration,
  ) {
    this.#canvas = canvas;
    this.#renderer = renderer;
    this.#reference_loader = reference_loader;
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
      new LightingReferenceLoader(),
      configuration,
    );
    lab.#frame = requestAnimationFrame((now) => lab.#draw(now));
    void lab.select_reference(configuration.initial_reference);
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
    this.#snapshot = {
      ...this.#common_snapshot(
        reference,
        this.#settings,
        this.#camera.move_speed,
      ),
      kind: "loading",
    };
    this.#emit();
    try {
      const loaded = reference === "cornell"
        ? undefined
        : await this.#load(reference);
      if (selection !== this.#selection_sequence || this.#disposed) return;
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
      this.#settings = presentation.settings;
      this.#camera.reset(
        presentation.camera,
        presentation.camera_target,
        presentation.move_speed,
      );
      this.#reset_frame_evidence();
      this.#started = performance.now();
      this.#displayed_reference = reference;
      if (reference === "cornell") {
        this.#model = undefined;
        this.#reference_scene = undefined;
        this.#cornell = cornell_scene({
          light_representation: this.#technique.selection === "raster"
            ? "raster_preview"
            : "area",
          settings: this.#settings,
        });
      } else {
        if (loaded === undefined) {
          throw new Error(`${reference} lighting reference did not load`);
        }
        this.#model = loaded.model;
        this.#cornell = undefined;
        this.#reference_scene = lighting_scene(
          0,
          loaded.model,
          presentation.camera,
          this.#settings,
          this.#fog_material_response,
          this.#reference_normal_response,
        );
      }
      const source_mesh_count = this.#cornell?.meshes.length ??
        loaded?.model.source_mesh_count ?? 0;
      const surface_count = this.#cornell?.objects.length ??
        loaded?.model.meshes.length ?? 0;
      const triangle_count = this.#cornell?.meshes.reduce(
        (count, mesh) => count + mesh.indices.length / 3,
        0,
      ) ?? loaded?.model.triangle_count ?? 0;
      this.#snapshot = {
        ...this.#common_snapshot(
          reference,
          this.#settings,
          this.#camera.move_speed,
        ),
        kind: "ready",
        load_milliseconds: loaded?.load_milliseconds ?? 0,
        pointer_locked: this.#camera.pointer_locked,
        source_materials: loaded?.source_materials ?? "procedural",
        source_mesh_count,
        surface_count,
        triangle_count,
      };
      this.#emit();
    } catch (error) {
      if (selection !== this.#selection_sequence || this.#disposed) return;
      this.#snapshot = {
        ...this.#common_snapshot(
          reference,
          this.#settings,
          this.#camera.move_speed,
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
    if (this.#displayed_reference === "cornell") {
      this.#cornell = cornell_scene({
        light_representation: this.#technique.selection === "raster"
          ? "raster_preview"
          : "area",
        settings: this.#settings,
      });
    } else if (
      this.#model !== undefined && this.#displayed_reference !== undefined
    ) {
      this.#reference_scene = lighting_scene(
        0,
        this.#model,
        reference_presentations[this.#displayed_reference].camera,
        this.#settings,
        this.#fog_material_response,
        this.#reference_normal_response,
      );
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
    if (this.#displayed_reference === "cornell") {
      this.#cornell = cornell_scene({
        light_representation: selected.selection === "raster"
          ? "raster_preview"
          : "area",
        settings: this.#settings,
      });
    }
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

  set_output_mode(output_mode: RenderOutputMode): void {
    this.#renderer.set_output_mode(output_mode);
    this.#replace_common_snapshot({ output_mode });
  }

  reset_camera(): void {
    const reference = this.#displayed_reference ?? this.#snapshot.reference;
    const presentation = reference_presentations[reference];
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
    this.#reference_loader.dispose();
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
    const loading = this.#reference_loader.load(reference);
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
    if (this.#displayed_reference === "cornell") {
      return this.#cornell === undefined
        ? undefined
        : { ...this.#cornell, camera };
    }
    if (
      this.#displayed_reference === "fog-room" && this.#model !== undefined
    ) {
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
    return this.#reference_scene === undefined
      ? undefined
      : { ...this.#reference_scene, camera };
  }

  #publish_frame(scene: RenderScene, frame: RenderFrameResult): void {
    if (this.#snapshot.kind !== "ready") return;
    let center_pick = this.#snapshot.center_pick;
    const should_sample_pick = (this.#displayed_reference === "cornell" ||
      this.#displayed_reference === "fog-room") &&
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
    readonly output_mode?: RenderOutputMode;
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
      output_mode: change.output_mode ?? this.#snapshot.output_mode,
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
      hdr_output: this.#renderer.hdr_output,
      move_speed,
      output_mode: this.#renderer.output_mode,
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
