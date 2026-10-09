import type { Catalog, SceneFile } from "@ink/schema";
import type { ImportStatus } from "@ink/assets/format";

export interface DevDiagnostic {
  /** Project-relative when inside the project. */
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
  excerpt: string;
}

/**
 * Where the time went on the server for one change, in epoch milliseconds
 * (`performance.timeOrigin + performance.now()`, shared with the page when both
 * run on one machine). The page adds its own stages and reports the total.
 */
export interface ChangeTrace {
  id: string;
  kind: "code" | "schema" | "scene" | "asset";
  /** Project-relative file that triggered the change. */
  file: string;
  /** Modification time of the file; null when it could not be read. */
  written: number | null;
  /** The watcher reported the change. */
  detected: number;
  /** The rebuild began (after debouncing and regenerating the schema). */
  started?: number;
  /** The compiler returned. */
  compiled?: number;
  /** The event was sent. */
  emitted: number;
  /** Compiler facts for a code or schema change. */
  compile?: {
    ms: number;
    freshModules: number;
    cachedModules: number;
    sourceBytes: number;
    bytes: number;
    /** Backend phases in milliseconds. */
    phases: Record<string, number>;
  };
}

export interface GameInfo {
  revision: number;
  /** `/__ink/game/<revision>.wasm` */
  url: string;
  /** Compile time in milliseconds. */
  ms: number;
  /** The compiled module, base64, when small enough to send with the event. */
  bytes?: string;
  /** The build produced the bytes already running: nothing to load. */
  unchanged?: boolean;
  trace?: ChangeTrace;
}

export interface ProjectInfo {
  title: string;
  catalog: Catalog;
  scenes: string[];
  game: GameInfo | null;
  diagnostics: DevDiagnostic[];
  /**
   * Import this to get the current schema (`default` export of schema.ts).
   * Changes on every schema edit, so the browser re-evaluates the module.
   */
  schemaUrl: string | null;
  /** Set on the `ink:project` event of a change; absent from GET /project. */
  trace?: ChangeTrace;
}

export interface DiagnosticsEvent {
  diagnostics: DevDiagnostic[];
  ms: number;
  trace?: ChangeTrace;
}

export interface AssetEvent {
  kind: "mesh" | "texture" | "sound" | "atlas" | "terrain" | "scatter";
  /** Path relative to the assets directory. */
  path: string;
  trace?: ChangeTrace;
}

/** Import progress: only the statuses that changed since the last event. */
export interface ImportsEvent {
  statuses: ImportStatus[];
}

export interface SceneEvent {
  name: string;
  /** True when the file was deleted. */
  removed?: boolean;
  /** The new contents, for small scenes; otherwise fetch the scene. */
  scene?: SceneFile;
  trace?: ChangeTrace;
}

/** Custom HMR events sent over Vite's websocket. */
export interface DevEvents {
  "ink:game": GameInfo;
  "ink:diagnostics": DiagnosticsEvent;
  "ink:project": ProjectInfo;
  "ink:asset": AssetEvent;
  "ink:imports": ImportsEvent;
  "ink:scene": SceneEvent;
  "ink:comments": Record<string, never>;
}

export interface BundleFile {
  name: string;
  text?: string;
  base64?: string;
}

export interface BundleRequest {
  id?: string;
  files: BundleFile[];
}

export interface BundleResult {
  id: string;
  /** Relative to the project directory. */
  dir: string;
}
