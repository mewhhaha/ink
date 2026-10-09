/**
 * Editor cameras: presentation only, never game state. A perspective camera
 * flies (right mouse + WASD) and orbits (Alt + left mouse) around a pivot;
 * orthographic top/front/side cameras pan and zoom about the cursor.
 */
import {
  type Aabb,
  aabbCenter,
  aabbSize,
  mat4,
  type Quat,
  quat,
  type Vec3,
  vec3,
} from "@ink/geometry";
import { type Camera, cameraFromMatrix } from "@ink/render";
import type { CameraPose } from "@ink/core";

export type ViewKind = "perspective" | "top" | "front" | "side";

export interface EditorCamera {
  kind: ViewKind;
  /** Perspective: eye position. Orthographic: the point at the view centre. */
  position: Vec3;
  /** Radians about +Y (perspective only). */
  yaw: number;
  /** Radians about +X; negative looks down (perspective only). */
  pitch: number;
  /** Distance from the eye to the orbit pivot. */
  distance: number;
  fov: number;
  /** Orthographic visible height in world units. */
  size: number;
}

export function defaultCamera(kind: ViewKind): EditorCamera {
  return kind === "perspective"
    ? {
      kind,
      position: [7, 5.5, 9],
      yaw: 0.66,
      pitch: -0.42,
      distance: 12,
      fov: 60,
      size: 10,
    }
    : {
      kind,
      position: [0, 0, 0],
      yaw: 0,
      pitch: 0,
      distance: 0,
      fov: 60,
      size: 16,
    };
}

const DEG = 180 / Math.PI;

export function cameraRotation(camera: EditorCamera): Quat {
  switch (camera.kind) {
    case "top":
      return quat.fromEuler([-90, 0, 0]);
    case "front":
      return quat.identity();
    case "side":
      return quat.fromEuler([0, 90, 0]);
    default:
      return quat.fromEuler([camera.pitch * DEG, camera.yaw * DEG, 0]);
  }
}

/** Where an orthographic camera sits: far back along its view axis. */
const ORTHO_DISTANCE = 1000;

export function cameraEye(camera: EditorCamera): Vec3 {
  if (camera.kind === "perspective") return camera.position;
  const back = quat.rotate(cameraRotation(camera), [0, 0, 1]);
  return vec3.add(camera.position, vec3.scale(back, ORTHO_DISTANCE));
}

export function renderCamera(camera: EditorCamera, aspect: number): Camera {
  const ortho = camera.kind !== "perspective";
  const world = mat4.compose(cameraEye(camera), cameraRotation(camera), [
    1,
    1,
    1,
  ]);
  return cameraFromMatrix(world, {
    fov: camera.fov,
    near: ortho ? 1 : 0.05,
    far: ortho ? ORTHO_DISTANCE * 2 : 6000,
    orthographic: ortho,
    size: camera.size,
  }, aspect);
}

export function cameraPose(camera: EditorCamera): CameraPose {
  return {
    position: cameraEye(camera),
    rotation: cameraRotation(camera),
    fov: camera.fov,
    orthographic: camera.kind !== "perspective",
    size: camera.size,
    view: camera.kind,
  };
}

export const forwardOf = (camera: EditorCamera): Vec3 =>
  quat.rotate(cameraRotation(camera), [0, 0, -1]);
export const rightOf = (camera: EditorCamera): Vec3 =>
  quat.rotate(cameraRotation(camera), [1, 0, 0]);
export const upOf = (camera: EditorCamera): Vec3 =>
  quat.rotate(cameraRotation(camera), [0, 1, 0]);

export function pivot(camera: EditorCamera): Vec3 {
  return vec3.add(
    camera.position,
    vec3.scale(forwardOf(camera), camera.distance),
  );
}

/** Mouse look: turn in place. */
export function look(
  camera: EditorCamera,
  dx: number,
  dy: number,
): EditorCamera {
  const pitch = Math.max(-1.55, Math.min(1.55, camera.pitch - dy * 0.004));
  return { ...camera, yaw: camera.yaw - dx * 0.004, pitch };
}

/** Orbit around the pivot. */
export function orbit(
  camera: EditorCamera,
  dx: number,
  dy: number,
): EditorCamera {
  const center = pivot(camera);
  const turned = look(camera, dx, dy);
  return {
    ...turned,
    position: vec3.sub(center, vec3.scale(forwardOf(turned), camera.distance)),
  };
}

/** Pan by CSS pixels; `pixelSize` is world units per pixel at the pivot. */
export function pan(
  camera: EditorCamera,
  dx: number,
  dy: number,
  pixelSize: number,
): EditorCamera {
  const offset = vec3.add(
    vec3.scale(rightOf(camera), -dx * pixelSize),
    vec3.scale(upOf(camera), dy * pixelSize),
  );
  return { ...camera, position: vec3.add(camera.position, offset) };
}

/** World units per CSS pixel at the pivot (perspective) or anywhere (ortho). */
export function pixelSize(
  camera: EditorCamera,
  viewportHeight: number,
): number {
  if (camera.kind !== "perspective") return camera.size / viewportHeight;
  return (2 * camera.distance * Math.tan((camera.fov / DEG) / 2)) /
    viewportHeight;
}

/** Wheel: dolly toward `target` (perspective) or zoom about it (ortho). */
export function zoom(
  camera: EditorCamera,
  delta: number,
  target?: Vec3,
): EditorCamera {
  const factor = Math.exp(delta * 0.0015);
  if (camera.kind !== "perspective") {
    const size = Math.max(0.05, Math.min(10000, camera.size * factor));
    if (!target) return { ...camera, size };
    // Keep the point under the cursor fixed.
    const keep = 1 - size / camera.size;
    const shifted = vec3.add(
      camera.position,
      vec3.scale(vec3.sub(target, camera.position), keep),
    );
    return { ...camera, size, position: shifted };
  }
  const direction = target
    ? vec3.normalize(vec3.sub(target, camera.position))
    : forwardOf(camera);
  const step = camera.distance * (1 - factor);
  const distance = Math.max(0.2, camera.distance * factor);
  return {
    ...camera,
    position: vec3.add(camera.position, vec3.scale(direction, step)),
    distance,
  };
}

/** Fly with held keys; `speed` in units per second. */
export function fly(
  camera: EditorCamera,
  keys: ReadonlySet<string>,
  dt: number,
  speed: number,
): EditorCamera {
  let move: Vec3 = [0, 0, 0];
  const add = (v: Vec3, s: number) => (move = vec3.add(move, vec3.scale(v, s)));
  if (keys.has("KeyW")) add(forwardOf(camera), 1);
  if (keys.has("KeyS")) add(forwardOf(camera), -1);
  if (keys.has("KeyD")) add(rightOf(camera), 1);
  if (keys.has("KeyA")) add(rightOf(camera), -1);
  if (keys.has("KeyE") || keys.has("Space")) add([0, 1, 0], 1);
  if (keys.has("KeyQ") || keys.has("ControlLeft")) add([0, 1, 0], -1);
  if (vec3.length(move) === 0) return camera;
  const fast = keys.has("ShiftLeft") || keys.has("ShiftRight") ? 3 : 1;
  return {
    ...camera,
    position: vec3.add(
      camera.position,
      vec3.scale(vec3.normalize(move), speed * fast * dt),
    ),
  };
}

/** Fit `bounds` in view. */
export function frame(
  camera: EditorCamera,
  bounds: Aabb,
  aspect: number,
): EditorCamera {
  const center = aabbCenter(bounds);
  const size = aabbSize(bounds);
  const radius = Math.max(0.5, vec3.length(size) / 2);
  if (camera.kind !== "perspective") {
    const extent = camera.kind === "top"
      ? Math.max(size[2], size[0] / aspect)
      : camera.kind === "front"
      ? Math.max(size[1], size[0] / aspect)
      : Math.max(size[1], size[2] / aspect);
    return { ...camera, position: center, size: Math.max(1, extent * 1.3) };
  }
  const distance = radius / Math.sin((camera.fov / DEG) / 2) * 1.1;
  return {
    ...camera,
    distance,
    position: vec3.sub(center, vec3.scale(forwardOf(camera), distance)),
  };
}

/** A pleasant three-quarter view of `bounds`, for captures. */
export function isoCamera(bounds: Aabb | null, aspect: number): EditorCamera {
  const base: EditorCamera = {
    ...defaultCamera("perspective"),
    yaw: Math.PI / 4,
    pitch: -0.55,
  };
  return bounds ? frame(base, bounds, aspect) : base;
}

/** The plane an orthographic view draws on (through the origin) as
 * [normal, axis indices of the two visible coordinates]. */
export function viewPlane(
  kind: ViewKind,
): { normal: Vec3; axes: [number, number] } {
  switch (kind) {
    case "top":
      return { normal: [0, 1, 0], axes: [0, 2] };
    case "front":
      return { normal: [0, 0, 1], axes: [0, 1] };
    case "side":
      return { normal: [1, 0, 0], axes: [2, 1] };
    default:
      return { normal: [0, 1, 0], axes: [0, 2] };
  }
}
