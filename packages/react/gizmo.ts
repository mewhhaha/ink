/**
 * Transform gizmos: drawing them as overlay lines, hit-testing a pointer ray,
 * and turning a drag into a translation, rotation or scale. Sizes are in
 * screen space so a gizmo looks the same at any distance.
 */
import { type Ray, type Vec3, vec3, type Vec4 } from "@ink/geometry";
import type { Line } from "@ink/render";
import type { Tool } from "./store.ts";

export type Axis = "x" | "y" | "z" | "xy" | "yz" | "xz" | "all";

const AXES: Record<"x" | "y" | "z", Vec3> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
};
const COLORS: Record<string, Vec4> = {
  x: [0.94, 0.38, 0.36, 1],
  y: [0.45, 0.82, 0.42, 1],
  z: [0.36, 0.61, 1, 1],
  all: [0.85, 0.87, 0.9, 1],
};
const HOVER: Vec4 = [1, 0.85, 0.3, 1];

/** Gizmo length in world units for a screen size of `pixels`. */
export function gizmoScale(
  origin: Vec3,
  eye: Vec3,
  worldPerPixelAtUnit: number,
  orthographic: boolean,
  pixels = 90,
): number {
  return orthographic
    ? worldPerPixelAtUnit * pixels
    : vec3.distance(origin, eye) * worldPerPixelAtUnit * pixels;
}

function circle(
  center: Vec3,
  normal: Vec3,
  radius: number,
  segments = 64,
): Vec3[] {
  const helper: Vec3 = Math.abs(normal[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = vec3.normalize(vec3.cross(normal, helper));
  const v = vec3.cross(normal, u);
  return Array.from({ length: segments + 1 }, (_, i) => {
    const a = (i / segments) * Math.PI * 2;
    return vec3.add(
      center,
      vec3.add(
        vec3.scale(u, Math.cos(a) * radius),
        vec3.scale(v, Math.sin(a) * radius),
      ),
    );
  });
}

function polyline(points: Vec3[], color: Vec4, width: number): Line[] {
  return points.slice(1).map((p, i) => ({
    from: points[i],
    to: p,
    color,
    width,
  }));
}

export function gizmoLines(
  tool: Tool,
  origin: Vec3,
  scale: number,
  hovered: Axis | null,
  eye: Vec3,
): Line[] {
  const lines: Line[] = [];
  const color = (
    axis: Axis,
  ) => (hovered === axis ? HOVER : COLORS[axis] ?? COLORS.all);
  if (tool === "move" || tool === "scale") {
    for (
      const [name, dir] of Object.entries(AXES) as ["x" | "y" | "z", Vec3][]
    ) {
      const tip = vec3.add(origin, vec3.scale(dir, scale));
      lines.push({
        from: vec3.add(origin, vec3.scale(dir, scale * 0.12)),
        to: tip,
        color: color(name),
        width: 3,
      });
      if (tool === "move") {
        // Arrow head: a small cone of lines.
        const side = vec3.scale(
          vec3.normalize(
            vec3.cross(dir, Math.abs(dir[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]),
          ),
          scale * 0.06,
        );
        const back = vec3.sub(tip, vec3.scale(dir, scale * 0.16));
        const other = vec3.scale(
          vec3.normalize(vec3.cross(dir, side)),
          scale * 0.06,
        );
        for (
          const s of [side, vec3.scale(side, -1), other, vec3.scale(other, -1)]
        ) {
          lines.push({
            from: tip,
            to: vec3.add(back, s),
            color: color(name),
            width: 3,
          });
        }
      } else {
        const half = scale * 0.05;
        const c = tip;
        for (const [a, b] of boxEdges(c, half)) {
          lines.push({ from: a, to: b, color: color(name), width: 3 });
        }
      }
    }
    if (tool === "move") {
      // Plane handles.
      const planes: [Axis, Vec3, Vec3][] = [["xy", AXES.x, AXES.y], [
        "yz",
        AXES.y,
        AXES.z,
      ], ["xz", AXES.x, AXES.z]];
      for (const [name, a, b] of planes) {
        const p0 = vec3.add(
          origin,
          vec3.add(vec3.scale(a, scale * 0.25), vec3.scale(b, scale * 0.25)),
        );
        const p1 = vec3.add(p0, vec3.scale(a, scale * 0.15));
        const p2 = vec3.add(p1, vec3.scale(b, scale * 0.15));
        const p3 = vec3.add(p0, vec3.scale(b, scale * 0.15));
        const c: Vec4 = hovered === name ? HOVER : [0.85, 0.87, 0.9, 0.7];
        lines.push(...polyline([p0, p1, p2, p3, p0], c, 2));
      }
    } else {
      for (const [a, b] of boxEdges(origin, scale * 0.07)) {
        lines.push({ from: a, to: b, color: color("all"), width: 3 });
      }
    }
  } else if (tool === "rotate") {
    for (
      const [name, dir] of Object.entries(AXES) as ["x" | "y" | "z", Vec3][]
    ) {
      lines.push(
        ...polyline(
          circle(origin, dir, scale * 0.8),
          color(name),
          hovered === name ? 4 : 3,
        ),
      );
    }
    const toEye = vec3.normalize(vec3.sub(eye, origin));
    lines.push(
      ...polyline(
        circle(origin, toEye, scale * 0.95),
        hovered === "all" ? HOVER : [0.85, 0.87, 0.9, 0.6],
        2,
      ),
    );
  }
  return lines;
}

function boxEdges(c: Vec3, h: number): [Vec3, Vec3][] {
  const p = (
    x: number,
    y: number,
    z: number,
  ): Vec3 => [c[0] + x * h, c[1] + y * h, c[2] + z * h];
  const corners = [
    p(-1, -1, -1),
    p(1, -1, -1),
    p(1, 1, -1),
    p(-1, 1, -1),
    p(-1, -1, 1),
    p(1, -1, 1),
    p(1, 1, 1),
    p(-1, 1, 1),
  ];
  const edges = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];
  return edges.map(([a, b]) => [corners[a], corners[b]]);
}

/** Closest distance between a ray and a segment, and the parameter along
 * the segment direction (0 at `a`). */
function raySegment(
  ray: Ray,
  a: Vec3,
  b: Vec3,
): { distance: number; t: number } {
  const u = ray.direction;
  const v = vec3.sub(b, a);
  const w = vec3.sub(ray.origin, a);
  const aa = vec3.dot(u, u),
    bb = vec3.dot(u, v),
    cc = vec3.dot(v, v),
    dd = vec3.dot(u, w),
    ee = vec3.dot(v, w);
  const denominator = aa * cc - bb * bb;
  let s = 0, t = 0;
  if (denominator > 1e-9) {
    s = (bb * ee - cc * dd) / denominator;
    t = (aa * ee - bb * dd) / denominator;
  } else {
    t = ee / cc;
  }
  t = Math.max(0, Math.min(1, t));
  s = Math.max(0, s);
  const p = vec3.add(ray.origin, vec3.scale(u, s));
  const q = vec3.add(a, vec3.scale(v, t));
  return { distance: vec3.distance(p, q), t };
}

function rayPoint(ray: Ray, point: Vec3): number {
  const t = Math.max(0, vec3.dot(vec3.sub(point, ray.origin), ray.direction));
  return vec3.distance(
    vec3.add(ray.origin, vec3.scale(ray.direction, t)),
    point,
  );
}

export function rayPlane(ray: Ray, normal: Vec3, point: Vec3): Vec3 | null {
  const facing = vec3.dot(normal, ray.direction);
  if (Math.abs(facing) < 1e-6) return null;
  const t = vec3.dot(normal, vec3.sub(point, ray.origin)) / facing;
  return t < 0 ? null : vec3.add(ray.origin, vec3.scale(ray.direction, t));
}

export function hitGizmo(
  tool: Tool,
  origin: Vec3,
  scale: number,
  ray: Ray,
  eye: Vec3,
): Axis | null {
  const threshold = scale * 0.07;
  if (tool === "move" || tool === "scale") {
    if (tool === "move") {
      const planes: [Axis, Vec3, Vec3, Vec3][] = [
        ["xy", AXES.z, AXES.x, AXES.y],
        ["yz", AXES.x, AXES.y, AXES.z],
        ["xz", AXES.y, AXES.x, AXES.z],
      ];
      for (const [name, normal, a, b] of planes) {
        const hit = rayPlane(ray, normal, origin);
        if (!hit) continue;
        const local = vec3.sub(hit, origin);
        const u = vec3.dot(local, a) / scale, v = vec3.dot(local, b) / scale;
        if (u > 0.23 && u < 0.42 && v > 0.23 && v < 0.42) return name;
      }
    } else if (rayPoint(ray, origin) < scale * 0.12) {
      return "all";
    }
    let best: Axis | null = null;
    let bestDistance = threshold;
    for (
      const [name, dir] of Object.entries(AXES) as ["x" | "y" | "z", Vec3][]
    ) {
      const { distance, t } = raySegment(
        ray,
        origin,
        vec3.add(origin, vec3.scale(dir, scale)),
      );
      if (distance < bestDistance && t > 0.1) {
        best = name;
        bestDistance = distance;
      }
    }
    return best;
  }
  if (tool === "rotate") {
    let best: Axis | null = null;
    let bestDistance = threshold * 1.4;
    for (
      const [name, dir] of Object.entries(AXES) as ["x" | "y" | "z", Vec3][]
    ) {
      const hit = rayPlane(ray, dir, origin) ??
        rayPlane(
          { origin: ray.origin, direction: ray.direction },
          vec3.scale(dir, -1),
          origin,
        );
      if (!hit) continue;
      const d = Math.abs(vec3.distance(hit, origin) - scale * 0.8);
      if (d < bestDistance) {
        best = name;
        bestDistance = d;
      }
    }
    if (best) return best;
    const toEye = vec3.normalize(vec3.sub(eye, origin));
    const hit = rayPlane(ray, toEye, origin) ??
      rayPlane(ray, vec3.scale(toEye, -1), origin);
    if (
      hit &&
      Math.abs(vec3.distance(hit, origin) - scale * 0.95) < threshold * 1.4
    ) return "all";
  }
  return null;
}

/** The plane a drag on `axis` moves within: contains the axis, faces the eye. */
function dragPlane(axis: Axis, origin: Vec3, eye: Vec3): Vec3 {
  const toEye = vec3.normalize(vec3.sub(eye, origin));
  if (axis === "xy") return AXES.z;
  if (axis === "yz") return AXES.x;
  if (axis === "xz") return AXES.y;
  if (axis === "all") return toEye;
  const dir = AXES[axis];
  const side = vec3.cross(dir, toEye);
  const normal = vec3.cross(side, dir);
  return vec3.length(normal) < 1e-6 ? toEye : vec3.normalize(normal);
}

function hitPlane(ray: Ray, normal: Vec3, origin: Vec3): Vec3 | null {
  return rayPlane(ray, normal, origin) ??
    rayPlane(ray, vec3.scale(normal, -1), origin);
}

/** World translation for a drag from `start` to `current`. */
export function dragTranslate(
  axis: Axis,
  origin: Vec3,
  eye: Vec3,
  start: Ray,
  current: Ray,
): Vec3 {
  const normal = dragPlane(axis, origin, eye);
  const a = hitPlane(start, normal, origin);
  const b = hitPlane(current, normal, origin);
  if (!a || !b) return [0, 0, 0];
  const delta = vec3.sub(b, a);
  if (axis === "x" || axis === "y" || axis === "z") {
    const dir = AXES[axis];
    return vec3.scale(dir, vec3.dot(delta, dir));
  }
  return delta;
}

/** Rotation axis and angle (radians) for a drag. */
export function dragRotate(
  axis: Axis,
  origin: Vec3,
  eye: Vec3,
  start: Ray,
  current: Ray,
): { axis: Vec3; angle: number } {
  const normal = axis === "x" || axis === "y" || axis === "z"
    ? AXES[axis]
    : vec3.normalize(vec3.sub(eye, origin));
  const a = hitPlane(start, normal, origin);
  const b = hitPlane(current, normal, origin);
  if (!a || !b) return { axis: normal, angle: 0 };
  const u = vec3.normalize(vec3.sub(a, origin));
  const v = vec3.normalize(vec3.sub(b, origin));
  const angle = Math.atan2(vec3.dot(vec3.cross(u, v), normal), vec3.dot(u, v));
  return { axis: normal, angle };
}

/** Per-axis scale factors for a drag. */
export function dragScale(
  axis: Axis,
  origin: Vec3,
  eye: Vec3,
  scale: number,
  start: Ray,
  current: Ray,
): Vec3 {
  if (axis === "all") {
    const normal = vec3.normalize(vec3.sub(eye, origin));
    const a = hitPlane(start, normal, origin);
    const b = hitPlane(current, normal, origin);
    if (!a || !b) return [1, 1, 1];
    const f = Math.max(
      0.01,
      1 + (vec3.distance(b, origin) - vec3.distance(a, origin)) / scale,
    );
    return [f, f, f];
  }
  const moved = dragTranslate(axis, origin, eye, start, current);
  const f = Math.max(
    0.01,
    1 +
      vec3.length(moved) *
        Math.sign(vec3.dot(moved, AXES[axis as "x"] ?? [1, 1, 1])) / scale,
  );
  return axis === "x"
    ? [f, 1, 1]
    : axis === "y"
    ? [1, f, 1]
    : axis === "z"
    ? [1, 1, f]
    : [1, 1, 1];
}
