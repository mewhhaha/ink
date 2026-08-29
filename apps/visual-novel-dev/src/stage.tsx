import {
  create_simple3d_renderer,
  type Simple3dMaterial,
  type Simple3dObject,
  type Simple3dScene,
} from "@ink/rendering/simple3d.ts";
import { useEffect, useRef, useState } from "react";

interface VisualNovelStageProps {
  readonly ending: boolean;
}

const station_concrete: Simple3dMaterial = {
  albedo: [0.12, 0.14, 0.18],
  emissive: [0, 0, 0],
  metallic: 0,
  roughness: 0.92,
};

export function VisualNovelStage({ ending }: VisualNovelStageProps) {
  const canvas_reference = useRef<HTMLCanvasElement>(null);
  const [failure, set_failure] = useState<string>();

  useEffect(() => {
    const canvas = canvas_reference.current;
    if (canvas === null) return;
    let active = true;
    let frame = 0;
    let release = () => {};
    const started = performance.now();
    void create_simple3d_renderer(canvas).then((renderer) => {
      if (!active) {
        renderer.dispose();
        return;
      }
      release = () => renderer.dispose();
      const draw = (now: number) => {
        renderer.render(visual_novel_scene((now - started) / 1_000, ending));
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
  }, [ending]);

  return (
    <div
      className="visual-novel-stage"
      data-render-failed={failure !== undefined}
    >
      <canvas ref={canvas_reference} aria-label="Moonlit station platform" />
      {failure !== undefined && <output aria-live="assertive">{failure}
      </output>}
    </div>
  );
}

export function visual_novel_scene(
  elapsed_seconds: number,
  ending: boolean,
): Simple3dScene {
  const objects: Simple3dObject[] = [
    {
      id: "platform",
      shape: "cube",
      position: [0, -0.35, 0],
      rotation_y_radians: 0,
      scale: [16, 0.7, 5],
      material: station_concrete,
    },
    {
      id: "track-bed",
      shape: "cube",
      position: [0, -0.8, -4],
      rotation_y_radians: 0,
      scale: [18, 0.5, 2.5],
      material: {
        albedo: [0.035, 0.04, 0.05],
        emissive: [0, 0, 0],
        metallic: 0.35,
        roughness: 0.75,
      },
    },
    ...platform_lights(),
    character("mara", [-1.15, 1.1, 0.4], [0.34, 0.09, 0.08]),
    character("ren", [1.1, 1.1, 0.15], [0.06, 0.15, 0.3]),
    {
      id: "signal",
      shape: "sphere",
      position: [5.5, 2.8, -1],
      rotation_y_radians: 0,
      scale: [0.25, 0.25, 0.25],
      material: {
        albedo: [0.04, 0.04, 0.04],
        emissive: ending ? [0.2, 7, 0.8] : [8, 0.18, 0.04],
        metallic: 0,
        roughness: 0.2,
      },
    },
  ];
  const drift = Math.sin(elapsed_seconds * 0.12) * 0.08;
  return {
    camera: {
      position: [0.2 + drift, 3.15, 8.8],
      target: [0, 1.35, 0],
      vertical_fov_radians: 0.72,
    },
    clear_color: [0.006, 0.009, 0.018],
    ambient_color: ending ? [0.06, 0.075, 0.08] : [0.025, 0.035, 0.075],
    directional_light: {
      color: [0.42, 0.55, 1],
      direction: [-0.35, -1, -0.22],
      intensity: 1.35,
    },
    point_lights: [
      {
        color: [1, 0.68, 0.36],
        position: [-4, 3.8, 1],
        intensity: 12,
        range: 8,
      },
      {
        color: [1, 0.68, 0.36],
        position: [4, 3.8, 1],
        intensity: 12,
        range: 8,
      },
      {
        color: ending ? [0.16, 1, 0.45] : [1, 0.04, 0.02],
        position: [5.5, 2.8, -1],
        intensity: 13,
        range: 6,
      },
    ],
    spot_lights: [{
      color: [0.65, 0.76, 1],
      position: [0, 7, 2],
      direction: [0, -1, -0.2],
      intensity: 12,
      range: 14,
      outer_angle_radians: 0.7,
    }],
    fog_color: [0.012, 0.02, 0.045],
    fog_density: 0.025,
    exposure: -0.45,
    bloom_intensity: 0.28,
    meshes: [],
    objects,
  };
}

function platform_lights(): readonly Simple3dObject[] {
  return [-4, 4].flatMap((x, index) =>
    [
      {
        id: `lamp-post-${index}`,
        shape: "cube",
        position: [x, 2, 1],
        rotation_y_radians: 0,
        scale: [0.12, 4, 0.12],
        material: {
          albedo: [0.08, 0.09, 0.11],
          emissive: [0, 0, 0],
          metallic: 0.8,
          roughness: 0.42,
        },
      },
      {
        id: `lamp-${index}`,
        shape: "sphere",
        position: [x, 3.8, 1],
        rotation_y_radians: 0,
        scale: [0.28, 0.28, 0.28],
        material: {
          albedo: [0.8, 0.65, 0.35],
          emissive: [7, 3.2, 0.8],
          metallic: 0,
          roughness: 0.15,
        },
      },
    ] satisfies Simple3dObject[]
  );
}

function character(
  id: string,
  position: readonly [number, number, number],
  color: readonly [number, number, number],
): Simple3dObject {
  return {
    id,
    shape: "sphere",
    position,
    rotation_y_radians: 0,
    scale: [1.1, 2.2, 0.85],
    material: {
      albedo: color,
      emissive: [0, 0, 0],
      metallic: 0,
      roughness: 0.68,
    },
  };
}
