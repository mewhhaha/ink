import type { RenderSnapshot } from "@ink/blot/protocol.ts";
import {
  type BuiltInGeometry,
  create_renderer,
  orthographic_render_camera,
  perspective_render_camera,
  render_color,
  render_directional_light,
  render_material,
  render_node_id,
  render_scene_hierarchy,
  render_scene_node,
  type RenderObject,
  type RenderScene,
  type RenderVector,
} from "@ink/rendering/renderer.ts";
import { useEffect, useRef, useState } from "react";

interface VisualNovelStageProps {
  readonly revision: number;
  readonly snapshot: RenderSnapshot;
}

interface CurrentPresentation {
  readonly revision: number;
  readonly snapshot: RenderSnapshot;
}

const built_in_geometry = new Map<number, BuiltInGeometry>([
  [0, "cube"],
  [1, "sphere"],
]);

export function VisualNovelStage(
  { revision, snapshot }: VisualNovelStageProps,
) {
  const stage_reference = useRef<HTMLDivElement>(null);
  const canvas_reference = useRef<HTMLCanvasElement>(null);
  const presentation_reference = useRef<CurrentPresentation>({
    revision,
    snapshot,
  });
  const [failure, set_failure] = useState<string>();
  presentation_reference.current = { revision, snapshot };

  useEffect(() => {
    const canvas = canvas_reference.current;
    if (canvas === null) return;
    let active = true;
    let frame = 0;
    let release = () => {};
    void create_renderer({
      canvas,
      technique: {
        type: "raster",
        path: "clustered_forward",
        sample_count: 4,
        anti_aliasing: "none",
      },
    }).then((renderer) => {
      if (!active) {
        renderer.dispose();
        return;
      }
      release = () => renderer.dispose();
      const draw = () => {
        const presentation = presentation_reference.current;
        try {
          const rendered = renderer.render(
            visual_novel_scene(
              presentation.snapshot,
              presentation.revision,
            ),
          );
          const stage = stage_reference.current;
          if (stage !== null) {
            stage.dataset.renderAdapter = renderer.adapter_description;
            stage.dataset.renderFrame = rendered.type;
            stage.dataset.renderReady = "true";
            stage.dataset.renderStatus = renderer.status.type;
            stage.dataset.renderValidationErrors = String(
              renderer.validation_error_count,
            );
          }
        } catch (error) {
          set_failure(error instanceof Error ? error.message : String(error));
          return;
        }
        frame = requestAnimationFrame(draw);
      };
      frame = requestAnimationFrame(draw);
    }).catch((error) => {
      if (active) {
        set_failure(error instanceof Error ? error.message : String(error));
      }
    });
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      release();
    };
  }, []);

  return (
    <div
      ref={stage_reference}
      className="visual-novel-stage"
      data-render-failed={failure !== undefined}
      data-render-ready="false"
    >
      <canvas ref={canvas_reference} aria-label="Moonlit station platform" />
      {failure !== undefined && <output aria-live="assertive">{failure}
      </output>}
    </div>
  );
}

export function visual_novel_scene(
  snapshot: RenderSnapshot,
  revision: number,
): RenderScene {
  if (snapshot.resources.length > 0) {
    throw new Error(
      `visual novel snapshot declares ${snapshot.resources.length} external resources; the station stage accepts built-in geometry only`,
    );
  }
  const nodes = [
    ...snapshot.nodes.map((node) =>
      render_scene_node(node.id, {
        position: scaled_vector(node.position),
        rotation: { type: "euler_xyz", radians: node.rotation_radians },
        scale: scaled_vector(node.scale),
        ...(node.parent === null
          ? {}
          : { parent: render_node_id(node.parent) }),
        visible: node.visible,
      })
    ),
    ...snapshot.objects.map((object) =>
      render_scene_node(object.id, {
        position: scaled_vector(object.position),
        rotation: { type: "euler_xyz", radians: object.rotation_radians },
        scale: scaled_vector(object.scale),
        ...(object.parent === null
          ? {}
          : { parent: render_node_id(object.parent) }),
        visible: object.visible,
      })
    ),
  ];
  const objects = snapshot.objects.map<RenderObject>((object) => {
    const shape = built_in_geometry.get(object.mesh);
    if (shape === undefined) {
      throw new Error(
        `visual novel object ${object.id} selects unsupported built-in mesh ${object.mesh}`,
      );
    }
    if (object.texture !== null || object.secondary_texture !== null) {
      throw new Error(
        `visual novel object ${object.id} selects an external texture`,
      );
    }
    return {
      id: `visual-novel-object-${object.id}`,
      shape,
      node: render_node_id(object.id),
      material: render_material(`visual-novel/object-${object.id}`, {
        albedo: object.color,
        emissive: [
          object.color[0] * object.emissive,
          object.color[1] * object.emissive,
          object.color[2] * object.emissive,
        ],
        metallic: object.surface_mode === 4 ? 0.3 : 0,
        roughness: object.surface_mode === 4 ? 0.38 : 0.78,
      }),
    };
  });
  const camera = snapshot.camera.type === "perspective"
    ? perspective_render_camera("visual-novel.station", {
      position: snapshot.camera.position,
      target: snapshot.camera.target,
      clear_color: snapshot.camera.clear_color,
      vertical_fov_radians: snapshot.camera.vertical_fov_radians,
    })
    : orthographic_render_camera("visual-novel.station", {
      position: snapshot.camera.position,
      target: snapshot.camera.target,
      clear_color: snapshot.camera.clear_color,
      vertical_size: snapshot.camera.vertical_size,
    });
  return {
    camera,
    hierarchy: render_scene_hierarchy("visual-novel/station", revision, nodes),
    lights: [render_directional_light("visual-novel.authored-light", {
      color: snapshot.directional_light.color,
      direction: snapshot.directional_light.direction,
      illuminance_lux: snapshot.directional_light.intensity * 10_000,
    })],
    environment: {
      ambient_light: render_color(snapshot.environment.ambient_light),
      fog_color: render_color(snapshot.environment.fog_color),
      fog_density: snapshot.environment.fog_density,
      exposure_ev100: snapshot.environment.exposure_ev100,
      bloom_intensity: snapshot.environment.bloom_intensity,
    },
    meshes: [],
    textures: [],
    objects,
  };
}

function scaled_vector(
  vector: readonly [number, number, number],
): RenderVector {
  return [
    vector[0] / 1_000_000,
    vector[1] / 1_000_000,
    vector[2] / 1_000_000,
  ];
}
