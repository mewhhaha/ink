import type { Mat4 } from "@ink/math/matrix.ts";
import type {
  CameraDefinition,
  CameraPose,
  NormalizedViewport,
  RenderSurfaceSize,
} from "../model.ts";
import { camera_id, surface_viewport } from "../model.ts";
import {
  build_camera_frame,
  type CameraHistory,
  type CameraView,
  type ViewFamily,
} from "../view.ts";

export interface XrCameraView {
  readonly eye: string;
  readonly pose: CameraPose;
  readonly projection_matrix: Mat4;
  readonly viewport: NormalizedViewport;
}

export interface XrViewCapability {
  views(surface: RenderSurfaceSize): readonly XrCameraView[];
}

export type XrViewFamilyResult =
  | { readonly type: "unavailable"; readonly reason: string }
  | {
    readonly type: "ready";
    readonly family: ViewFamily;
    readonly history: ReadonlyMap<string, CameraHistory>;
  }
  | { readonly type: "failed"; readonly reason: string };

export function adapt_xr_view_family(
  capability: XrViewCapability | undefined,
  base: CameraDefinition,
  surface: RenderSurfaceSize,
  frame_index: number,
  previous: ReadonlyMap<string, CameraHistory> = new Map(),
): XrViewFamilyResult {
  if (capability === undefined) {
    return { type: "unavailable", reason: "XR view capability is unavailable" };
  }
  try {
    surface_viewport(surface);
  } catch (error) {
    return {
      type: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (!Number.isSafeInteger(frame_index) || frame_index < 0) {
    return {
      type: "failed",
      reason: `XR frame index ${
        JSON.stringify(frame_index)
      } must be a nonnegative safe integer`,
    };
  }
  const parsed_surface = Object.freeze({ ...surface });
  let supplied: readonly XrCameraView[];
  try {
    supplied = capability.views(parsed_surface);
  } catch (error) {
    return {
      type: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (!Array.isArray(supplied)) {
    return {
      type: "failed",
      reason: "XR view capability must return an array",
    };
  }
  if (supplied.length === 0) {
    return { type: "failed", reason: "XR view capability returned no views" };
  }
  const eyes = new Set<string>();
  const views: CameraView[] = [];
  const histories = new Map<string, CameraHistory>();
  for (const [index, xr_view] of supplied.entries()) {
    if (typeof xr_view !== "object" || xr_view === null) {
      return {
        type: "failed",
        reason: `XR view ${index} must be an object`,
      };
    }
    if (typeof xr_view.eye !== "string") {
      return {
        type: "failed",
        reason: `XR view ${index} eye must be a string`,
      };
    }
    const eye = xr_view.eye.trim();
    if (eye.length === 0 || eyes.has(eye)) {
      return {
        type: "failed",
        reason: eye.length === 0
          ? "XR view eye cannot be empty"
          : `XR view eye ${JSON.stringify(eye)} appears more than once`,
      };
    }
    eyes.add(eye);
    const camera: CameraDefinition = {
      ...base,
      id: camera_id(`${base.id}:${eye}`),
      pose: xr_view.pose,
      viewport: xr_view.viewport,
      projection: {
        type: "custom",
        matrix: xr_view.projection_matrix,
        near: base.projection.near,
        far: base.projection.far,
        depth: base.projection.depth,
      },
    };
    let frame: ReturnType<typeof build_camera_frame>;
    try {
      frame = build_camera_frame({
        camera,
        surface: parsed_surface,
        frame_index,
        previous: previous.get(eye),
        jitter_scale_pixels: 0,
      });
    } catch (error) {
      return {
        type: "failed",
        reason: `XR view ${index} is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (frame.type !== "ready") {
      return {
        type: "failed",
        reason: frame.type === "invalid_projection"
          ? `${frame.field}: ${frame.reason}`
          : `${frame.operation}: ${frame.reason}`,
      };
    }
    views.push(frame.frame.view);
    histories.set(eye, frame.frame.history);
  }
  return {
    type: "ready",
    family: Object.freeze({
      id: `${base.id}:xr`,
      views: Object.freeze(views),
    }),
    history: histories,
  };
}
