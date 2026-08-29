import {
  parse_static_glb_scene,
  type StaticGltfScene,
} from "@ink/assets/gltf_model.ts";
import {
  create_simple3d_renderer,
  simple3d_texture_id,
  type Simple3dTexture,
} from "@ink/rendering/simple3d.ts";
import {
  lighting_scene,
  type LightingReference,
  reference_presentations,
} from "./scene.ts";
import "./styles.css";

const canvas = required_element("scene", HTMLCanvasElement);
const adapter = required_element("adapter", HTMLOutputElement);
const statistics = required_element("scene-statistics", HTMLOutputElement);
const scene_title = required_element("scene-title", HTMLHeadingElement);
const scene_description = required_element(
  "scene-description",
  HTMLParagraphElement,
);
const scene_buttons = [...document.querySelectorAll<HTMLButtonElement>(
  "button[data-reference]",
)];
interface LoadedReference {
  readonly scene: StaticGltfScene;
  readonly textures: readonly Simple3dTexture[];
}

const loaded_scenes = new Map<LightingReference, LoadedReference>();

try {
  const renderer = await create_simple3d_renderer(canvas);
  let selected: LightingReference = "fog-room";
  let loaded_reference = await load_reference("fog-room");
  let started = performance.now();
  let frame = 0;

  const select = async (reference: LightingReference): Promise<void> => {
    set_loading(reference);
    try {
      const loaded = await load_reference(reference);
      selected = reference;
      loaded_reference = loaded;
      started = performance.now();
      show_selected(reference, loaded.scene);
    } catch (error) {
      adapter.value = error instanceof Error ? error.message : String(error);
    } finally {
      scene_buttons.forEach((button) => button.disabled = false);
    }
  };
  for (const button of scene_buttons) {
    button.addEventListener("click", () => {
      const reference = parse_reference(button.dataset.reference);
      void select(reference);
    });
  }

  const draw = (now: number) => {
    renderer.render(
      lighting_scene(
        (now - started) / 1_000,
        loaded_reference.scene,
        selected,
        loaded_reference.textures,
      ),
    );
    frame = requestAnimationFrame(draw);
  };
  show_selected(selected, loaded_reference.scene);
  frame = requestAnimationFrame(draw);
  void select("bistro");

  globalThis.addEventListener("pagehide", () => {
    cancelAnimationFrame(frame);
    renderer.dispose();
    for (const loaded of loaded_scenes.values()) {
      loaded.textures.forEach(({ source }) => source.close());
    }
  }, { once: true });

  function set_loading(reference: LightingReference): void {
    scene_buttons.forEach((button) => button.disabled = true);
    const presentation = reference_presentations[reference];
    scene_title.textContent = presentation.title;
    scene_description.textContent = `Loading ${presentation.title}…`;
    adapter.value = renderer.adapter_description;
    statistics.value = "Parsing model geometry";
  }

  function show_selected(
    reference: LightingReference,
    scene: StaticGltfScene,
  ): void {
    const presentation = reference_presentations[reference];
    scene_title.textContent = presentation.title;
    scene_description.textContent = presentation.description;
    adapter.value = renderer.adapter_description;
    statistics.value = `${scene.meshes.length.toLocaleString()} mesh parts · ${
      vertex_count(scene).toLocaleString()
    } vertices`;
    scene_buttons.forEach((button) => {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.reference === reference),
      );
    });
  }
} catch (error) {
  adapter.value = error instanceof Error ? error.message : String(error);
  document.body.dataset.renderFailed = "true";
  throw error;
}

async function load_reference(
  reference: LightingReference,
): Promise<LoadedReference> {
  const cached = loaded_scenes.get(reference);
  if (cached !== undefined) return cached;
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
  const referenced_texture_ids = new Set(
    scene.meshes.flatMap(({ material }) =>
      material.base_color_texture === undefined
        ? []
        : [material.base_color_texture]
    ),
  );
  const textures: Simple3dTexture[] = [];
  try {
    for (
      const texture of scene.textures.filter(({ id }) =>
        referenced_texture_ids.has(id)
      )
    ) {
      textures.push({
        id: simple3d_texture_id(texture.id),
        source: await createImageBitmap(
          new Blob([texture.bytes.slice().buffer], {
            type: texture.mime_type,
          }),
        ),
      });
    }
  } catch (error) {
    textures.forEach(({ source }) => source.close());
    throw error;
  }
  const loaded = { scene, textures };
  loaded_scenes.set(reference, loaded);
  return loaded;
}

function vertex_count(scene: StaticGltfScene): number {
  return scene.meshes.reduce(
    (count, mesh) => count + mesh.vertices.length / 8,
    0,
  );
}

function parse_reference(value: string | undefined): LightingReference {
  if (value === "bistro" || value === "caldera" || value === "fog-room") {
    return value;
  }
  throw new Error(`unknown lighting reference ${JSON.stringify(value)}`);
}

function required_element<T extends typeof Element>(
  id: string,
  constructor: T,
): InstanceType<T> {
  const element = document.getElementById(id);
  if (!(element instanceof constructor)) {
    throw new Error(`lighting lab index is missing ${JSON.stringify(id)}`);
  }
  return element as InstanceType<T>;
}
