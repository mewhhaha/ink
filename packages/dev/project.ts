import type { UserConfig } from "vite";

/** `ink.config.ts` default export. Kept tiny so browsers never pull in Vite. */
export interface ProjectConfig {
  title?: string;
  /** Default `./schema.ts`. */
  schema?: string;
  /** Default `./game/main.blot`. */
  game?: string;
  /** Default `./scenes`. */
  scenes?: string;
  /** Default `./assets`. */
  assets?: string;
  /** Merged into the dev server's Vite config. */
  vite?: UserConfig;
}

export function defineProject(config: ProjectConfig): ProjectConfig {
  return config;
}
