/**
 * Browser-safe entry of @ink/dev: project config, protocol types and the
 * automation contract. The Vite plugin lives in `@ink/dev/vite`, the browser
 * client in `@ink/dev/client`, the CLI in `@ink/dev/cli`.
 */
export { defineProject, type ProjectConfig } from "./project.ts";
export type * from "./protocol.ts";
export type {
  CaptureOptions,
  CaptureResult,
  InkAutomation,
  RunOptions,
} from "./automation.ts";
