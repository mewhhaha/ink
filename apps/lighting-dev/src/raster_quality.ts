import { visibility_id } from "@ink/visibility/model.ts";
import {
  create_renderer,
  perspective_render_camera,
  render_color,
  render_material,
  render_mesh_id,
  render_node_id,
  render_scene_hierarchy,
  render_scene_node,
  render_texture_id,
  type Renderer,
  type RenderMesh,
  type RenderPickResult,
  type RenderScene,
} from "@ink/rendering/renderer.ts";

type ProofDistance = "near" | "far";

interface RasterQualitySnapshot {
  readonly adapter: string;
  readonly distance: ProofDistance;
  readonly frame: ReturnType<Renderer["render"]>;
  readonly pick: RenderPickResult;
  readonly status: Renderer["status"];
  readonly validation_error_count: number;
}

const target_object_id = "raster-quality-target";
const texture_size = 256;
const root_element = document.querySelector("main");
const canvas_element = document.querySelector("canvas");
const output_element = document.querySelector("output");
const distance_buttons = [...document.querySelectorAll<HTMLButtonElement>(
  "button[data-distance]",
)];
if (!(root_element instanceof HTMLElement)) {
  throw new Error("raster quality proof requires a main element");
}
if (!(canvas_element instanceof HTMLCanvasElement)) {
  throw new Error("raster quality proof requires a canvas element");
}
if (!(output_element instanceof HTMLOutputElement)) {
  throw new Error("raster quality proof requires an output element");
}
const root = root_element;
const canvas = canvas_element;
const output = output_element;

void start_raster_quality_proof().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  root.dataset.runtimeState = "failed";
  output.value = message;
});

async function start_raster_quality_proof(): Promise<void> {
  const checker_source = await create_checker_source();
  const checker_id = render_texture_id("raster-quality-checker");
  const detailed_mesh = vertical_quad_mesh("raster-quality-detailed", 2);
  const distant_mesh = vertical_triangle_mesh("raster-quality-distant", 1.7);
  const material = render_material("raster-quality-material", {
    albedo: [1, 1, 1],
    base_color_texture: checker_id,
    emissive: [0, 0, 0],
    metallic: 0,
    roughness: 0.8,
  });
  const hierarchy = render_scene_hierarchy("raster-quality", 0, [
    render_scene_node(0, {
      position: [0, 0, 0],
      rotation: { type: "y_axis", radians: 1.05 },
      scale: [1, 1, 1],
    }),
  ]);
  const shared_scene = {
    hierarchy,
    lights: [],
    environment: {
      ambient_light: render_color([1.2, 1.2, 1.2]),
      fog_color: render_color([0, 0, 0]),
      fog_density: 0,
      exposure_ev100: 0,
      bloom_intensity: 0,
    },
    meshes: [detailed_mesh, distant_mesh],
    textures: [{
      color_space: "srgb" as const,
      id: checker_id,
      source: checker_source,
    }],
    objects: [{
      id: target_object_id,
      shape: "mesh" as const,
      mesh: detailed_mesh.id,
      node: render_node_id(0),
      material,
      raster_visibility: {
        id: visibility_id("raster-quality/target"),
        lods: [
          {
            id: "detailed",
            minimum_projected_pixels: 180,
            geometry: { shape: "mesh" as const, mesh: detailed_mesh.id },
          },
          {
            id: "distant",
            minimum_projected_pixels: 0,
            geometry: { shape: "mesh" as const, mesh: distant_mesh.id },
          },
        ],
      },
    }],
  } satisfies Omit<RenderScene, "camera">;
  const scenes: Readonly<Record<ProofDistance, RenderScene>> = {
    near: {
      ...shared_scene,
      camera: proof_camera([0, 0, 5]),
    },
    far: {
      ...shared_scene,
      camera: proof_camera([0, 0, 28]),
    },
  };
  const renderer = await create_renderer({
    canvas,
    technique: {
      type: "raster",
      path: "clustered_forward",
      sample_count: 1,
      anti_aliasing: "none",
    },
  });
  let current = render_distance(renderer, scenes, "near");
  const browser_control = {
    show_distance(distance: ProofDistance): RasterQualitySnapshot {
      current = render_distance(renderer, scenes, distance);
      return current;
    },
    snapshot(): RasterQualitySnapshot {
      return {
        ...current,
        status: renderer.status,
        validation_error_count: renderer.validation_error_count,
      };
    },
  };
  Object.assign(globalThis, { __ink_raster_quality: browser_control });
  for (const button of distance_buttons) {
    button.disabled = false;
    button.addEventListener("click", () => {
      const distance = button.dataset.distance;
      if (distance !== "near" && distance !== "far") {
        throw new Error(
          `raster quality button has invalid distance ${
            JSON.stringify(distance)
          }`,
        );
      }
      browser_control.show_distance(distance);
    });
  }
  globalThis.addEventListener("pagehide", () => {
    checker_source.close();
    renderer.dispose();
  }, { once: true });
}

function render_distance(
  renderer: Renderer,
  scenes: Readonly<Record<ProofDistance, RenderScene>>,
  distance: ProofDistance,
): RasterQualitySnapshot {
  const scene = scenes[distance];
  const frame = renderer.render(scene);
  if (frame.type !== "raster") {
    throw new Error(
      `raster quality proof received ${JSON.stringify(frame.type)} frame`,
    );
  }
  const submitted = frame.visibility.submitted.find(({ object_id }) =>
    object_id === target_object_id
  );
  if (submitted === undefined) {
    throw new Error(
      `raster quality target was not submitted: ${
        JSON.stringify(frame.visibility)
      }`,
    );
  }
  const pick = renderer.pick(scene, {
    x: Math.floor(canvas.width / 2),
    y: Math.floor(canvas.height / 2),
  });
  const snapshot = {
    adapter: renderer.adapter_description,
    distance,
    frame,
    pick,
    status: renderer.status,
    validation_error_count: renderer.validation_error_count,
  } satisfies RasterQualitySnapshot;
  root.dataset.distance = distance;
  root.dataset.lod = submitted.lod;
  root.dataset.pick = pick.type === "hit" ? pick.object_id : pick.type;
  root.dataset.runtimeState = "ready";
  output.value = JSON.stringify(snapshot);
  return snapshot;
}

function proof_camera(position: readonly [number, number, number]) {
  return perspective_render_camera("raster-quality-camera", {
    position,
    target: [0, 0, 0],
    vertical_fov_radians: Math.PI / 3,
    clear_color: [0.003, 0.003, 0.003],
  });
}

function vertical_quad_mesh(id: string, half_extent: number): RenderMesh {
  return {
    id: render_mesh_id(id),
    vertices: new Float32Array([
      -half_extent,
      -half_extent,
      0,
      0,
      0,
      1,
      0,
      2,
      half_extent,
      -half_extent,
      0,
      0,
      0,
      1,
      2,
      2,
      half_extent,
      half_extent,
      0,
      0,
      0,
      1,
      2,
      0,
      -half_extent,
      half_extent,
      0,
      0,
      0,
      1,
      0,
      0,
    ]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

function vertical_triangle_mesh(id: string, half_extent: number): RenderMesh {
  return {
    id: render_mesh_id(id),
    vertices: new Float32Array([
      -half_extent,
      -half_extent,
      0,
      0,
      0,
      1,
      0,
      2,
      half_extent,
      -half_extent,
      0,
      0,
      0,
      1,
      2,
      2,
      0,
      half_extent,
      0,
      0,
      0,
      1,
      1,
      0,
    ]),
    indices: new Uint32Array([0, 1, 2]),
  };
}

async function create_checker_source(): Promise<ImageBitmap> {
  const source = document.createElement("canvas");
  source.width = texture_size;
  source.height = texture_size;
  const context = source.getContext("2d");
  if (context === null) {
    throw new Error("raster quality proof could not create a 2D texture");
  }
  const cells = 16;
  const cell_size = texture_size / cells;
  for (let y = 0; y < cells; y += 1) {
    for (let x = 0; x < cells; x += 1) {
      context.fillStyle = (x + y) % 2 === 0 ? "#f4c432" : "#195ee6";
      context.fillRect(x * cell_size, y * cell_size, cell_size, cell_size);
    }
  }
  return await createImageBitmap(source);
}
