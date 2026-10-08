import type { InputModel, SceneFile } from "@ink/schema";
import type { NetworkStatus, Scenario, ScenarioResult } from "@ink/core";

export interface CaptureOptions {
  /** A scene name from `/__ink/scenes`. */
  scene?: string;
  /** An explicit world to render; wins over `scene`. */
  state?: SceneFile;
  /** A hand-off id under `.ink/handoffs`; its `state.scene.json` is loaded. */
  handoff?: string;
  /** Play this many fixed ticks (idle input) before capturing. */
  ticks?: number;
  /** `game`, `editor`, `top`, `front`, `side` or `iso`. */
  view?: string;
  width?: number;
  height?: number;
  /** Render quality; defaults to the renderer's (low on software GPUs).
   * `high` adds ambient occlusion, bloom, auto exposure and finer shadows. */
  quality?: "low" | "high";
}

export interface CaptureResult {
  /** PNG data URL. */
  png: string;
  tick: number;
  /** Description of the view that rendered (camera, size, ...). */
  view: unknown;
}

export interface RunOptions {
  scene?: string;
  state?: SceneFile;
  ticks?: number;
  /** Recorded inputs, replayed through the live session and timeline. */
  inputs?: InputModel[];
}

/**
 * `window.__ink`, installed by the app (via @ink/react) when the page is
 * opened with `?ink-automation`. `deno task ink capture` drives it.
 */
export interface InkAutomation {
  /** Resolves once the game is built and loaded, the scene loaded and assets settled. */
  ready: Promise<void>;
  capture(options: CaptureOptions): Promise<CaptureResult>;
  run(options: RunOptions): Promise<SceneFile>;
  scenario(
    options: { scenario: Scenario; updateGoldens?: boolean },
  ): Promise<ScenarioResult>;
  state(): SceneFile;
  /** Network diagnostics; a retained tick also returns its exact state packet. */
  network(
    tick?: number,
  ): (NetworkStatus & { hash?: string; state?: number[] }) | null;
}
