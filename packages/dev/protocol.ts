import type { Catalog } from "@ink/schema";

export interface DevDiagnostic {
  /** Project-relative when inside the project. */
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
  excerpt: string;
}

export interface GameInfo {
  revision: number;
  /** `/__ink/game/<revision>.wasm` */
  url: string;
  /** Compile time in milliseconds. */
  ms: number;
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
}

export interface DiagnosticsEvent {
  diagnostics: DevDiagnostic[];
  ms: number;
}

export interface AssetEvent {
  kind: "mesh" | "texture" | "sound";
  /** Path relative to the assets directory. */
  path: string;
}

export interface SceneEvent {
  name: string;
  /** True when the file was deleted. */
  removed?: boolean;
}

/** Custom HMR events sent over Vite's websocket. */
export interface DevEvents {
  "ink:game": GameInfo;
  "ink:diagnostics": DiagnosticsEvent;
  "ink:project": ProjectInfo;
  "ink:asset": AssetEvent;
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
