/** State every view of a renderer shares. */
import type { Assets } from "./assets.ts";
import type { PostPipelines } from "./post/pipelines.ts";
import type { Pipelines } from "./pipelines.ts";
import type { Dummies } from "./resources.ts";
import type { Quality } from "./types.ts";

export interface Core {
  device: GPUDevice;
  format: GPUTextureFormat;
  pipelines: Pipelines;
  post: PostPipelines;
  assets: Assets;
  /** Neutral stand-ins for every extension resource of the frame group. */
  dummies: Dummies;
  /** Quality views use unless `Overlays.quality` says otherwise. */
  quality: Quality;
  /** Set once the device is lost; views then do nothing. */
  lost: boolean;
  /** Frames rendered, for resource aging. */
  frame: number;
}
