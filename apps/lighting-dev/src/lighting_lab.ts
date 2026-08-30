import {
  parse_static_glb_scene,
  type StaticGltfScene,
} from "@ink/assets/gltf_model.ts";
import {
  create_simple3d_renderer,
  type Simple3dRenderer,
  type Simple3dTexture,
} from "@ink/rendering/simple3d.ts";
import { create_caldera_surface_texture } from "./caldera_surface.ts";
import { DebugCamera } from "./debug_camera.ts";
import {
  lighting_scene,
  type LightingReference,
  type LightingReferenceModel,
  type LightingSettings,
  prepare_lighting_reference,
  reference_presentations,
  reference_texture_id,
  type ReferenceTextureUsage,
} from "./scene.ts";

interface LightingLabSnapshotBase {
  readonly adapter: string;
  readonly move_speed: number;
  readonly reference: LightingReference;
  readonly settings: LightingSettings;
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
  readonly #listeners = new Set<() => void>();
  readonly #loaded = new Map<LightingReference, Promise<LoadedReference>>();
  readonly #renderer: Simple3dRenderer;
  #disposed = false;
  #frame = 0;
  #last_frame_time = performance.now();
  #model: LightingReferenceModel | undefined;
  #selection_sequence = 0;
  #settings = reference_presentations.bistro.settings;
  #snapshot: LightingLabSnapshot;
  #started = performance.now();

  private constructor(
    canvas: HTMLCanvasElement,
    renderer: Simple3dRenderer,
    initial_reference: LightingReference,
  ) {
    this.#renderer = renderer;
    const presentation = reference_presentations[initial_reference];
    this.#camera = new DebugCamera(
      canvas,
      presentation.camera,
      presentation.move_speed,
      (move_speed) => this.#replace_common_snapshot({ move_speed }),
    );
    this.#snapshot = {
      adapter: renderer.adapter_description,
      kind: "loading",
      move_speed: presentation.move_speed,
      reference: initial_reference,
      settings: presentation.settings,
    };
  }

  static async create(
    canvas: HTMLCanvasElement,
    initial_reference: LightingReference,
  ): Promise<LightingLab> {
    const renderer = await create_simple3d_renderer(canvas);
    const lab = new LightingLab(canvas, renderer, initial_reference);
    await lab.select_reference(initial_reference);
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
    this.#snapshot = {
      adapter: this.#renderer.adapter_description,
      kind: "loading",
      move_speed: presentation.move_speed,
      reference,
      settings: presentation.settings,
    };
    this.#emit();
    try {
      const loaded = await this.#load(reference);
      if (selection !== this.#selection_sequence || this.#disposed) return;
      this.#model = loaded.model;
      this.#settings = presentation.settings;
      this.#camera.reset(presentation.camera, presentation.move_speed);
      this.#started = performance.now();
      this.#snapshot = {
        adapter: this.#renderer.adapter_description,
        kind: "ready",
        load_milliseconds: loaded.load_milliseconds,
        move_speed: this.#camera.move_speed,
        pointer_locked: this.#camera.pointer_locked,
        reference,
        settings: this.#settings,
        source_mesh_count: loaded.model.source_mesh_count,
        surface_count: loaded.model.meshes.length,
        triangle_count: loaded.model.triangle_count,
      };
      this.#emit();
    } catch (error) {
      if (selection !== this.#selection_sequence || this.#disposed) return;
      this.#snapshot = {
        adapter: this.#renderer.adapter_description,
        kind: "failed",
        message: error instanceof Error ? error.message : String(error),
        move_speed: presentation.move_speed,
        reference,
        settings: presentation.settings,
      };
      this.#emit();
    }
  }

  set_setting(setting: keyof LightingSettings, value: number): void {
    if (!Number.isFinite(value)) {
      throw new Error(`lighting ${setting} ${value} must be finite`);
    }
    this.#settings = { ...this.#settings, [setting]: value };
    this.#replace_common_snapshot({ settings: this.#settings });
  }

  set_move_speed(speed: number): void {
    this.#camera.set_move_speed(speed);
  }

  reset_camera(): void {
    const presentation = reference_presentations[this.#snapshot.reference];
    this.#camera.reset(presentation.camera, presentation.move_speed);
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

  #load(reference: LightingReference): Promise<LoadedReference> {
    const cached = this.#loaded.get(reference);
    if (cached !== undefined) return cached;
    const loading = load_reference(reference);
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
      if (this.#model !== undefined) {
        this.#renderer.render(
          lighting_scene(
            (now - this.#started) / 1_000,
            this.#model,
            camera,
            this.#settings,
          ),
        );
      }
      if (
        this.#snapshot.kind === "ready" &&
        this.#snapshot.pointer_locked !== this.#camera.pointer_locked
      ) {
        this.#snapshot = {
          ...this.#snapshot,
          pointer_locked: this.#camera.pointer_locked,
        };
        this.#emit();
      }
      this.#frame = requestAnimationFrame((next) => this.#draw(next));
    } catch (error) {
      this.#snapshot = {
        adapter: this.#renderer.adapter_description,
        kind: "failed",
        message: error instanceof Error ? error.message : String(error),
        move_speed: this.#camera.move_speed,
        reference: this.#snapshot.reference,
        settings: this.#settings,
      };
      this.#emit();
    }
  }

  #replace_common_snapshot(change: {
    readonly move_speed?: number;
    readonly settings?: LightingSettings;
  }): void {
    this.#snapshot = {
      ...this.#snapshot,
      move_speed: change.move_speed ?? this.#snapshot.move_speed,
      settings: change.settings ?? this.#snapshot.settings,
    };
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

async function load_reference(
  reference: LightingReference,
): Promise<LoadedReference> {
  const started = performance.now();
  const presentation = reference_presentations[reference];
  const response = await fetch(presentation.source);
  if (!response.ok) {
    throw new Error(
      `${presentation.title} is unavailable (HTTP ${response.status}); run pnpm sync:lighting-scenes`,
    );
  }
  const scene = parse_static_glb_scene(
    new Uint8Array(await response.arrayBuffer()),
    presentation.source,
  );
  const textures = await decode_reference_textures(scene);
  try {
    if (reference === "caldera") {
      textures.push(await create_caldera_surface_texture());
    }
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

async function decode_reference_textures(
  scene: StaticGltfScene,
): Promise<Simple3dTexture[]> {
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
  const textures: Simple3dTexture[] = [];
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
