/** Camera construction. Cameras look down their local -Z axis. */
import { type Mat4, mat4, type Vec3 } from "@ink/geometry";
import type { Camera, CameraSettings, RenderScene } from "./types.ts";

/** A camera placed by a world matrix (scale is ignored). `settings.fov` is the
 * vertical field of view in degrees; `settings.size` the orthographic height. */
export function cameraFromMatrix(
  world: Mat4,
  settings: CameraSettings,
  aspect: number,
): Camera {
  const { t, r } = mat4.decompose(world);
  const view = mat4.invert(mat4.compose(t, r, [1, 1, 1]));
  const projection = settings.orthographic
    ? mat4.orthographic(
      (-settings.size * aspect) / 2,
      (settings.size * aspect) / 2,
      -settings.size / 2,
      settings.size / 2,
      settings.near,
      settings.far,
    )
    : mat4.perspective(
      (settings.fov * Math.PI) / 180,
      aspect,
      settings.near,
      settings.far,
    );
  return {
    view,
    projection,
    position: t,
    near: settings.near,
    far: settings.far,
    orthographic: settings.orthographic,
  };
}

/** The camera of the first active camera entity, or `null`. */
export function gameCamera(scene: RenderScene, aspect: number): Camera | null {
  const found = scene.cameras.find((c) => c.camera.active);
  return found ? cameraFromMatrix(found.matrix, found.camera, aspect) : null;
}

/** An editor-style camera from an eye position looking at a target. */
export function lookAtCamera(
  eye: Vec3,
  target: Vec3,
  settings: Partial<CameraSettings> & { up?: Vec3 },
  aspect: number,
): Camera {
  const s: CameraSettings = {
    fov: 60,
    near: 0.1,
    far: 500,
    orthographic: false,
    size: 10,
    ...settings,
  };
  const view = mat4.lookAt(eye, target, settings.up ?? [0, 1, 0]);
  const projection = s.orthographic
    ? mat4.orthographic(
      (-s.size * aspect) / 2,
      (s.size * aspect) / 2,
      -s.size / 2,
      s.size / 2,
      s.near,
      s.far,
    )
    : mat4.perspective((s.fov * Math.PI) / 180, aspect, s.near, s.far);
  return {
    view,
    projection,
    position: eye,
    near: s.near,
    far: s.far,
    orthographic: s.orthographic,
  };
}
