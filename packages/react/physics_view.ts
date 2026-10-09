/**
 * Debug drawing for physics: every collider's shape, coloured by what it is,
 * and the contacts of the last physics step. Presentation only: it reads the
 * world and never changes it. The shapes follow the rules of the physics
 * library (`ink/shapes`, `ink/scene`): collider sizes follow the transform's
 * scale; a dynamic body ignores the collider offset; a character is an upright
 * capsule whatever the transform's scale and rotation.
 */
import {
  brushEdges,
  mat4,
  quat,
  type Vec3,
  vec3,
  type Vec4,
} from "@ink/geometry";
import type { Line } from "@ink/render";
import type { EntityModel, WorldModel } from "@ink/schema";

const STATIC: Vec4 = [0.38, 0.62, 0.98, 0.95];
const DYNAMIC: Vec4 = [0.35, 0.92, 0.45, 0.95];
const SLEEPING: Vec4 = [0.2, 0.62, 0.42, 0.8];
const KINEMATIC: Vec4 = [1, 0.62, 0.22, 0.95];
const CHARACTER: Vec4 = [0.35, 0.92, 0.98, 0.95];
const TRIGGER: Vec4 = [1, 0.88, 0.25, 0.85];
const SELECTED: Vec4 = [1, 1, 1, 1];
const CONTACT: Vec4 = [1, 0.28, 0.2, 1];

/** Floats per contact in the `physics.contacts` resource. */
export const CONTACT_STRIDE = 12;

type Record = { [field: string]: unknown };

export interface PhysicsViewOptions {
  selection?: readonly number[];
  /** Draw contact points and normals. Default true. */
  contacts?: boolean;
  /** At most this many contacts. Default 600. */
  maxContacts?: number;
}

/** True if a world has anything to draw. */
export function hasPhysics(world: WorldModel): boolean {
  return world.entities.some((e) => e.components.collider);
}

/** The lines for colliders and contacts. */
export function physicsLines(
  world: WorldModel,
  options: PhysicsViewOptions = {},
): Line[] {
  const byId = new Map<number, EntityModel>();
  for (const e of world.entities) byId.set(e.id, e);
  const matrices = new Map<number, ReturnType<typeof mat4.identity>>();
  const matrixOf = (e: EntityModel, depth = 0): ReturnType<
    typeof mat4.identity
  > => {
    const cached = matrices.get(e.id);
    if (cached) return cached;
    const t = e.components.transform as Record | undefined;
    let m = mat4.compose(
      (t?.position as Vec3) ?? [0, 0, 0],
      (t?.rotation as Vec4) ?? [0, 0, 0, 1],
      (t?.scale as Vec3) ?? [1, 1, 1],
    );
    const parent = e.parent ? byId.get(e.parent) : undefined;
    if (parent && depth < 16) m = mat4.multiply(matrixOf(parent, depth + 1), m);
    matrices.set(e.id, m);
    return m;
  };
  const selected = new Set(options.selection ?? []);
  const lines: Line[] = [];
  for (const e of world.entities) {
    const collider = e.components.collider as Record | undefined;
    const brush = e.components.brush as { faces: Record[] } | undefined;
    if (!collider && !brush?.faces?.length) continue;
    // A brush without a collider is static level geometry; do not outline
    // every wall of a level unless it is selected or the view wants it.
    const body = e.components.body as Record | undefined;
    const character = e.components.character as Record | undefined;
    const trigger = !!collider?.trigger;
    const kind = (body?.kind as string | undefined) ?? "static";
    const color = selected.has(e.id)
      ? SELECTED
      : trigger
      ? TRIGGER
      : character
      ? CHARACTER
      : kind === "dynamic"
      ? (body?.sleeping ? SLEEPING : DYNAMIC)
      : kind === "kinematic"
      ? KINEMATIC
      : STATIC;
    const m = matrixOf(e);
    const t = e.components.transform as Record | undefined;
    const position = (t?.position as Vec3) ?? [0, 0, 0];
    // World pose, as the library sees it: composed through the parents.
    const world3 = mat4.decompose(m);
    let rotation = world3.r;
    let scale = world3.s.map(Math.abs) as Vec3;
    void position;
    if (character) {
      rotation = [0, 0, 0, 1];
      scale = [1, 1, 1];
    }
    const origin = world3.t;
    const shape = (collider?.shape as string | undefined) ?? "hull";
    const offset = (kind === "dynamic" ? [0, 0, 0] : collider?.offset ??
      [0, 0, 0]) as Vec3;
    const center = vec3.add(
      origin,
      quat.rotate(rotation, [
        offset[0] * scale[0],
        offset[1] * scale[1],
        offset[2] * scale[2],
      ]),
    );
    if (shape === "box") {
      const size = (collider?.size as Vec3) ?? [1, 1, 1];
      boxLines(
        center,
        rotation,
        [
          size[0] * scale[0] / 2,
          size[1] * scale[1] / 2,
          size[2] * scale[2] / 2,
        ],
        color,
        lines,
      );
    } else if (shape === "sphere") {
      const radius = ((collider?.radius as number) ?? 0.5) *
        Math.max(...scale);
      capsuleLines(center, rotation, 0, radius, color, lines);
    } else if (shape === "capsule") {
      const radius = ((collider?.radius as number) ?? 0.5) *
        Math.max(scale[0], scale[2]);
      const half = Math.max(
        0,
        ((collider?.height as number) ?? 2) * scale[1] / 2 - radius,
      );
      capsuleLines(center, rotation, half, radius, color, lines);
    } else if (brush?.faces?.length) {
      const planes = brush.faces.map((f) => f.plane as Vec4);
      for (const [a, b] of brushEdges(planes)) {
        lines.push({
          from: mat4.transformPoint(m, a),
          to: mat4.transformPoint(m, b),
          color,
          width: 1.5,
        });
      }
    }
  }
  if (options.contacts !== false) {
    const contacts = world.resources.physics?.contacts as number[] | undefined;
    if (contacts) {
      const count = Math.min(
        Math.floor(contacts.length / CONTACT_STRIDE),
        options.maxContacts ?? 600,
      );
      for (let i = 0; i < count; i++) {
        const o = i * CONTACT_STRIDE;
        const p: Vec3 = [contacts[o + 2], contacts[o + 3], contacts[o + 4]];
        const n: Vec3 = [contacts[o + 5], contacts[o + 6], contacts[o + 7]];
        const r = 0.05;
        lines.push(
          {
            from: [p[0] - r, p[1], p[2]],
            to: [p[0] + r, p[1], p[2]],
            color: CONTACT,
            width: 2,
          },
          {
            from: [p[0], p[1] - r, p[2]],
            to: [p[0], p[1] + r, p[2]],
            color: CONTACT,
            width: 2,
          },
          {
            from: [p[0], p[1], p[2] - r],
            to: [p[0], p[1], p[2] + r],
            color: CONTACT,
            width: 2,
          },
          {
            from: p,
            to: [p[0] + n[0] * 0.3, p[1] + n[1] * 0.3, p[2] + n[2] * 0.3],
            color: CONTACT,
            width: 2,
          },
        );
      }
    }
  }
  return lines;
}

function boxLines(
  center: Vec3,
  rotation: Vec4,
  half: Vec3,
  color: Vec4,
  out: Line[],
) {
  const corners: Vec3[] = [];
  for (let i = 0; i < 8; i++) {
    const local: Vec3 = [
      i & 1 ? half[0] : -half[0],
      i & 2 ? half[1] : -half[1],
      i & 4 ? half[2] : -half[2],
    ];
    corners.push(vec3.add(center, quat.rotate(rotation, local)));
  }
  for (let i = 0; i < 8; i++) {
    for (let axis = 0; axis < 3; axis++) {
      const j = i ^ (1 << axis);
      if (j > i) {
        out.push({ from: corners[i], to: corners[j], color, width: 1.5 });
      }
    }
  }
}

/** A capsule standing on the local Y axis; `half` 0 makes a sphere. */
function capsuleLines(
  center: Vec3,
  rotation: Vec4,
  half: number,
  radius: number,
  color: Vec4,
  out: Line[],
) {
  const x = quat.rotate(rotation, [1, 0, 0]);
  const y = quat.rotate(rotation, [0, 1, 0]);
  const z = quat.rotate(rotation, [0, 0, 1]);
  const top = vec3.add(center, vec3.scale(y, half));
  const bottom = vec3.sub(center, vec3.scale(y, half));
  const ring = (c: Vec3, u: Vec3, v: Vec3, segments = 20) => {
    let prev: Vec3 | null = null;
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const p = vec3.add(
        c,
        vec3.add(
          vec3.scale(u, Math.cos(a) * radius),
          vec3.scale(v, Math.sin(a) * radius),
        ),
      );
      if (prev) out.push({ from: prev, to: p, color, width: 1.5 });
      prev = p;
    }
  };
  const arc = (c: Vec3, u: Vec3, up: number, segments = 10) => {
    let prev: Vec3 | null = null;
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI;
      const p = vec3.add(
        c,
        vec3.add(
          vec3.scale(u, Math.cos(a) * radius),
          vec3.scale(y, up * Math.sin(a) * radius),
        ),
      );
      if (prev) out.push({ from: prev, to: p, color, width: 1.5 });
      prev = p;
    }
  };
  if (half > 0) {
    ring(top, x, z);
    ring(bottom, x, z);
    for (const u of [x, z]) {
      arc(top, u, 1);
      arc(bottom, u, -1);
      for (const s of [-1, 1]) {
        const d = vec3.scale(u, s * radius);
        out.push({
          from: vec3.add(top, d),
          to: vec3.add(bottom, d),
          color,
          width: 1.5,
        });
      }
    }
  } else {
    ring(center, x, z);
    ring(center, x, y);
    ring(center, y, z);
  }
}
