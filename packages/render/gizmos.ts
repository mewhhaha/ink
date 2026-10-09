/**
 * Editor gizmos for objects that have no geometry of their own: lights and
 * cameras, as lines. Pass the result in `Overlays.lines`.
 */
import { mat4, type Vec3, vec3, type Vec4 } from "@ink/geometry";
import type { Line, RenderScene } from "./types.ts";

const LIGHT: Vec4 = [1, 0.86, 0.35, 0.95];
const CAMERA: Vec4 = [0.62, 0.78, 1, 0.95];
const SELECTED: Vec4 = [1, 0.62, 0.16, 1];

function circle(
  center: Vec3,
  u: Vec3,
  v: Vec3,
  radius: number,
  color: Vec4,
  out: Line[],
  segments = 32,
) {
  let prev: Vec3 | null = null;
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const c = Math.cos(a) * radius, s = Math.sin(a) * radius;
    const p: Vec3 = [
      center[0] + u[0] * c + v[0] * s,
      center[1] + u[1] * c + v[1] * s,
      center[2] + u[2] * c + v[2] * s,
    ];
    if (prev) out.push({ from: prev, to: p, color, width: 1.5 });
    prev = p;
  }
}

/** Lines for every light and camera in the scene. `selection` highlights. */
export function sceneGizmos(
  scene: RenderScene,
  options: { selection?: readonly number[]; scale?: number } = {},
): Line[] {
  const selected = new Set(options.selection ?? []);
  const scale = options.scale ?? 1;
  const out: Line[] = [];

  for (const probe of scene.probes ?? []) {
    const color = selected.has(probe.entity) ? SELECTED : CAMERA;
    const at = (p: Vec3) => mat4.transformPoint(probe.matrix, p);
    const center = at([0, 0, 0]);
    for (
      const [u, v] of [[[1, 0, 0], [0, 1, 0]], [[1, 0, 0], [0, 0, 1]]] as [
        Vec3,
        Vec3,
      ][]
    ) {
      circle(
        center,
        vec3.normalize(mat4.transformDirection(probe.matrix, u)),
        vec3.normalize(mat4.transformDirection(probe.matrix, v)),
        0.3 * scale,
        color,
        out,
        16,
      );
    }
    if (!selected.has(probe.entity)) continue;
    const corners = Array.from(
      { length: 8 },
      (_, i) =>
        at(probe.size.map((v, k) => v * (i & (1 << k) ? 0.5 : -0.5)) as Vec3),
    );
    for (let i = 0; i < 8; i++) {
      for (let axis = 0; axis < 3; axis++) {
        const j = i ^ (1 << axis);
        if (j > i) {
          out.push({ from: corners[i], to: corners[j], color, width: 1.5 });
        }
      }
    }
  }

  for (const light of scene.lights) {
    const m = scene.matrices.get(light.entity)!;
    const color = selected.has(light.entity) ? SELECTED : LIGHT;
    const p = light.position;
    const x = vec3.normalize(mat4.transformDirection(m, [1, 0, 0]));
    const y = vec3.normalize(mat4.transformDirection(m, [0, 1, 0]));
    const z = vec3.normalize(mat4.transformDirection(m, [0, 0, 1]));
    const r = 0.25 * scale;
    circle(p, x, y, r, color, out);
    if (light.kind === "directional") {
      const d = light.direction;
      for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const o: Vec3 = [
          p[0] + (x[0] * dx + y[0] * dy) * r,
          p[1] + (x[1] * dx + y[1] * dy) * r,
          p[2] + (x[2] * dx + y[2] * dy) * r,
        ];
        out.push({
          from: o,
          to: [
            o[0] + d[0] * 1.5 * scale,
            o[1] + d[1] * 1.5 * scale,
            o[2] + d[2] * 1.5 * scale,
          ],
          color,
          width: 1.5,
        });
      }
    } else if (light.kind === "point") {
      circle(p, y, z, r, color, out);
      circle(p, x, z, r, color, out);
      if (selected.has(light.entity) && light.range > 0) {
        const faint: Vec4 = [color[0], color[1], color[2], 0.45];
        circle(p, x, y, light.range, faint, out, 64);
        circle(p, y, z, light.range, faint, out, 64);
        circle(p, x, z, light.range, faint, out, 64);
      }
    } else {
      const length = selected.has(light.entity) && light.range > 0
        ? light.range * Math.cos((light.angle * Math.PI) / 360)
        : Math.min(light.range || 3, 3) * scale;
      const half = (light.angle * Math.PI) / 360;
      const reach = Math.tan(half) * length;
      const tip: Vec3 = [
        p[0] - z[0] * length,
        p[1] - z[1] * length,
        p[2] - z[2] * length,
      ];
      circle(tip, x, y, reach, color, out);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        out.push({
          from: p,
          to: [
            tip[0] + (x[0] * dx + y[0] * dy) * reach,
            tip[1] + (x[1] * dx + y[1] * dy) * reach,
            tip[2] + (x[2] * dx + y[2] * dy) * reach,
          ],
          color,
          width: 1.5,
        });
      }
    }
  }

  for (const { entity, matrix, camera } of scene.cameras) {
    const color = selected.has(entity) ? SELECTED : CAMERA;
    const depth = Math.min(camera.far, 2.5 * scale);
    // Frame at `depth` in front of the camera, aspect 16:9.
    const halfH = camera.orthographic
      ? camera.size / 2
      : Math.tan((camera.fov * Math.PI) / 360) * depth;
    const halfW = halfH * (16 / 9);
    const corner = (cx: number, cy: number, z: number) =>
      mat4.transformPoint(matrix, [cx * halfW, cy * halfH, z]);
    const signs = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const;
    const far = signs.map(([cx, cy]) => corner(cx, cy, -depth));
    const origin = mat4.transformPoint(matrix, [0, 0, 0]);
    far.forEach((c, i) => {
      // Perspective rays meet at the camera; orthographic ones run parallel.
      const from = camera.orthographic
        ? corner(signs[i][0], signs[i][1], 0)
        : origin;
      out.push({ from, to: c, color, width: 1.5 });
      out.push({ from: c, to: far[(i + 1) % 4], color, width: 1.5 });
    });
    const corners = far;
    // Up marker triangle above the frame.
    const top = mat4.transformPoint(matrix, [0, halfH * 1.35, -depth]);
    out.push({ from: corners[2], to: top, color, width: 1.5 });
    out.push({ from: top, to: corners[3], color, width: 1.5 });
  }
  return out;
}
