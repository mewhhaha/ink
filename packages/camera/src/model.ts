import { type Mat4, mat4, mat4_inverse } from "@ink/math/matrix.ts";
import { type Quat, quat } from "@ink/math/quaternion.ts";
import { finite_number } from "@ink/math/scalar.ts";
import { type Vec3, vec3 } from "@ink/math/vector.ts";
import type { SceneNodeId } from "@ink/scene/identity.ts";

declare const camera_id_brand: unique symbol;
export type CameraId = string & { readonly [camera_id_brand]: true };

export type DepthConvention = "standard" | "reversed";

interface ProjectionDepth {
  readonly near: number;
  readonly far: number;
  readonly depth: DepthConvention;
}

export type CameraProjection =
  | (ProjectionDepth & {
    readonly type: "perspective";
    readonly vertical_fov_radians: number;
  })
  | (ProjectionDepth & {
    readonly type: "orthographic";
    readonly vertical_size: number;
  })
  | (ProjectionDepth & {
    readonly type: "physical";
    readonly sensor_height_millimeters: number;
    readonly focal_length_millimeters: number;
  })
  | (ProjectionDepth & {
    readonly type: "custom";
    readonly matrix: Mat4;
  });

export interface CameraPose {
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly scene_node?: SceneNodeId;
}

export interface NormalizedViewport {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PixelViewport {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface RenderSurfaceSize {
  readonly width: number;
  readonly height: number;
}

export type CameraClear =
  | { readonly type: "load" }
  | {
    readonly type: "color";
    readonly color: readonly [number, number, number, number];
  };

export interface CameraDefinition {
  readonly id: CameraId;
  readonly pose: CameraPose;
  readonly projection: CameraProjection;
  readonly viewport: NormalizedViewport;
  readonly layers: number;
  readonly order: number;
  readonly clear: CameraClear;
}

export interface CameraStack {
  readonly cameras: readonly CameraDefinition[];
}

export interface ProjectionFailure {
  readonly type: "invalid_projection";
  readonly camera: CameraId;
  readonly field: string;
  readonly value: number;
  readonly reason: string;
}

export type CameraDefinitionResult =
  | { readonly type: "ready"; readonly camera: CameraDefinition }
  | ProjectionFailure;

export function camera_id(value: string): CameraId {
  const parsed = value.trim();
  if (parsed.length === 0) {
    throw new Error(`camera id ${JSON.stringify(value)} cannot be empty`);
  }
  return parsed as CameraId;
}

export function create_camera(
  definition: CameraDefinition,
): CameraDefinitionResult {
  const projection_failure = validate_projection(
    definition.id,
    definition.projection,
  );
  if (projection_failure !== undefined) return projection_failure;
  const viewport_failure = validate_viewport(
    definition.id,
    definition.viewport,
  );
  if (viewport_failure !== undefined) return viewport_failure;
  if (
    !Number.isSafeInteger(definition.layers) || definition.layers < 0 ||
    definition.layers > 0xffff_ffff
  ) {
    return failure(
      definition.id,
      "layers",
      definition.layers,
      "camera layers must be an unsigned 32-bit integer",
    );
  }
  if (!Number.isSafeInteger(definition.order)) {
    return failure(
      definition.id,
      "order",
      definition.order,
      "camera order must be a safe integer",
    );
  }
  const clear_type = (definition.clear as { readonly type: string }).type;
  if (clear_type !== "load" && clear_type !== "color") {
    return failure(
      definition.id,
      "clear.type",
      Number.NaN,
      `camera clear type ${JSON.stringify(clear_type)} is invalid`,
    );
  }
  if (definition.clear.type === "color") {
    if (definition.clear.color.length !== 4) {
      return failure(
        definition.id,
        "clear.color",
        definition.clear.color.length,
        "clear color must contain four components",
      );
    }
    for (const [index, component] of definition.clear.color.entries()) {
      if (!Number.isFinite(component) || component < 0 || component > 1) {
        return failure(
          definition.id,
          `clear.color[${index}]`,
          component,
          "clear color components must be finite values in 0..1",
        );
      }
    }
  }
  const position = definition.pose.position;
  const rotation = definition.pose.rotation;
  if (
    !Number.isFinite(position.x) || !Number.isFinite(position.y) ||
    !Number.isFinite(position.z) || !Number.isFinite(rotation.x) ||
    !Number.isFinite(rotation.y) || !Number.isFinite(rotation.z) ||
    !Number.isFinite(rotation.w)
  ) {
    return failure(
      definition.id,
      "pose",
      Number.NaN,
      "camera pose components must be finite",
    );
  }
  const rotation_length = Math.hypot(
    rotation.x,
    rotation.y,
    rotation.z,
    rotation.w,
  );
  if (rotation_length === 0) {
    return failure(
      definition.id,
      "pose.rotation",
      rotation_length,
      "camera rotation cannot be zero",
    );
  }
  const parsed_pose = Object.freeze({
    position: vec3(position.x, position.y, position.z),
    rotation: quat(rotation.x, rotation.y, rotation.z, rotation.w),
    ...(definition.pose.scene_node === undefined
      ? {}
      : { scene_node: definition.pose.scene_node }),
  });
  const parsed_projection = definition.projection.type === "custom"
    ? Object.freeze({
      ...definition.projection,
      matrix: mat4([...definition.projection.matrix]),
    })
    : Object.freeze({ ...definition.projection });
  const color = definition.clear.type === "color"
    ? Object.freeze([...definition.clear.color]) as unknown as readonly [
      number,
      number,
      number,
      number,
    ]
    : undefined;
  const parsed_clear: CameraClear = definition.clear.type === "load"
    ? Object.freeze({ type: "load" })
    : Object.freeze({
      type: "color",
      color: color!,
    });
  return Object.freeze({
    type: "ready",
    camera: Object.freeze({
      id: definition.id,
      pose: parsed_pose,
      projection: parsed_projection,
      layers: definition.layers >>> 0,
      order: definition.order,
      viewport: Object.freeze({ ...definition.viewport }),
      clear: parsed_clear,
    }),
  });
}

export function create_camera_stack(
  definitions: readonly CameraDefinition[],
): CameraStack | { readonly type: "invalid_stack"; readonly reason: string } {
  const ids = new Set<CameraId>();
  const cameras: CameraDefinition[] = [];
  for (const definition of definitions) {
    const parsed = create_camera(definition);
    if (parsed.type === "invalid_projection") {
      return {
        type: "invalid_stack",
        reason: `camera ${
          JSON.stringify(parsed.camera)
        } field ${parsed.field}: ${parsed.reason}`,
      };
    }
    if (ids.has(parsed.camera.id)) {
      return {
        type: "invalid_stack",
        reason: `camera stack repeats ${JSON.stringify(parsed.camera.id)}`,
      };
    }
    ids.add(parsed.camera.id);
    cameras.push(parsed.camera);
  }
  cameras.sort((left, right) =>
    left.order - right.order || left.id.localeCompare(right.id)
  );
  return Object.freeze({ cameras: Object.freeze(cameras) });
}

export function resolve_viewport(
  parent: PixelViewport,
  child: NormalizedViewport,
): PixelViewport {
  if (
    !Number.isFinite(parent.x) || !Number.isFinite(parent.y) ||
    !Number.isFinite(parent.width) || parent.width <= 0 ||
    !Number.isFinite(parent.height) || parent.height <= 0
  ) {
    throw new Error(
      `parent pixel viewport ${
        JSON.stringify(parent)
      } must have a finite origin and positive finite size`,
    );
  }
  const parsed = validate_viewport(camera_id("viewport"), child);
  if (parsed !== undefined) throw new Error(parsed.reason);
  return {
    x: parent.x + parent.width * child.x,
    y: parent.y + parent.height * child.y,
    width: parent.width * child.width,
    height: parent.height * child.height,
  };
}

export function surface_viewport(size: RenderSurfaceSize): PixelViewport {
  if (!Number.isSafeInteger(size.width) || size.width <= 0) {
    throw new Error(
      `render surface width ${
        JSON.stringify(size.width)
      } must be a positive safe integer`,
    );
  }
  if (!Number.isSafeInteger(size.height) || size.height <= 0) {
    throw new Error(
      `render surface height ${
        JSON.stringify(size.height)
      } must be a positive safe integer`,
    );
  }
  return { x: 0, y: 0, width: size.width, height: size.height };
}

function validate_projection(
  camera: CameraId,
  projection: CameraProjection,
): ProjectionFailure | undefined {
  const projection_type = (projection as { readonly type: string }).type;
  if (
    projection_type !== "perspective" &&
    projection_type !== "orthographic" && projection_type !== "physical" &&
    projection_type !== "custom"
  ) {
    return failure(
      camera,
      "projection.type",
      Number.NaN,
      `projection type ${JSON.stringify(projection_type)} is invalid`,
    );
  }
  if (projection.depth !== "standard" && projection.depth !== "reversed") {
    return failure(
      camera,
      "projection.depth",
      Number.NaN,
      `projection depth ${JSON.stringify(projection.depth)} is invalid`,
    );
  }
  if (!Number.isFinite(projection.near) || projection.near <= 0) {
    return failure(
      camera,
      "projection.near",
      projection.near,
      "near plane must be positive and finite",
    );
  }
  if (!Number.isFinite(projection.far) || projection.far <= projection.near) {
    return failure(
      camera,
      "projection.far",
      projection.far,
      `far plane must be finite and greater than near ${projection.near}`,
    );
  }
  if (projection.type === "perspective") {
    if (
      !Number.isFinite(projection.vertical_fov_radians) ||
      projection.vertical_fov_radians <= 0 ||
      projection.vertical_fov_radians >= Math.PI
    ) {
      return failure(
        camera,
        "projection.vertical_fov_radians",
        projection.vertical_fov_radians,
        "vertical field of view must be between zero and pi",
      );
    }
  }
  if (projection.type === "orthographic") {
    if (
      !Number.isFinite(projection.vertical_size) ||
      projection.vertical_size <= 0
    ) {
      return failure(
        camera,
        "projection.vertical_size",
        projection.vertical_size,
        "orthographic vertical size must be positive and finite",
      );
    }
  }
  if (projection.type === "physical") {
    for (
      const [field, value] of [
        ["sensor_height_millimeters", projection.sensor_height_millimeters],
        ["focal_length_millimeters", projection.focal_length_millimeters],
      ] as const
    ) {
      if (!Number.isFinite(value) || value <= 0) {
        return failure(
          camera,
          `projection.${field}`,
          value,
          `${field} must be positive and finite`,
        );
      }
    }
    const vertical_fov_radians = 2 * Math.atan(
      projection.sensor_height_millimeters /
        (2 * projection.focal_length_millimeters),
    );
    if (vertical_fov_radians <= 0 || vertical_fov_radians >= Math.PI) {
      return failure(
        camera,
        "projection",
        vertical_fov_radians,
        "physical camera values must produce a field of view between zero and pi",
      );
    }
  }
  if (projection.type === "custom") {
    if (projection.matrix.length !== 16) {
      return failure(
        camera,
        "projection.matrix",
        projection.matrix.length,
        "custom projection matrix must contain 16 components",
      );
    }
    for (const [index, value] of projection.matrix.entries()) {
      if (!Number.isFinite(value)) {
        return failure(
          camera,
          `projection.matrix[${index}]`,
          value,
          "custom projection components must be finite",
        );
      }
    }
    const inverse = mat4_inverse(projection.matrix);
    if (!inverse.ok) {
      return failure(
        camera,
        "projection.matrix",
        inverse.pivot,
        `custom projection matrix is singular at pivot ${inverse.pivot}`,
      );
    }
  }
  return undefined;
}

function validate_viewport(
  camera: CameraId,
  viewport: NormalizedViewport,
): ProjectionFailure | undefined {
  for (
    const [field, value] of [
      ["x", viewport.x],
      ["y", viewport.y],
      ["width", viewport.width],
      ["height", viewport.height],
    ] as const
  ) {
    try {
      finite_number(value, `camera viewport ${field}`);
    } catch {
      return failure(
        camera,
        `viewport.${field}`,
        value,
        `${field} must be finite`,
      );
    }
  }
  if (
    viewport.x < 0 || viewport.y < 0 || viewport.width <= 0 ||
    viewport.height <= 0 ||
    viewport.x + viewport.width > 1 || viewport.y + viewport.height > 1
  ) {
    return failure(
      camera,
      "viewport",
      viewport.width * viewport.height,
      `normalized viewport ${JSON.stringify(viewport)} must fit within 0..1`,
    );
  }
  return undefined;
}

function failure(
  camera: CameraId,
  field: string,
  value: number,
  reason: string,
): ProjectionFailure {
  return { type: "invalid_projection", camera, field, value, reason };
}
