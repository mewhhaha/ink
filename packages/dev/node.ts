/** Deno-side project resolution shared by the plugin and the CLI. */
import { dirname, join, resolve, toFileUrl } from "@std/path";
import type { Schema } from "@ink/schema";
import type { ProjectConfig } from "./project.ts";

export interface ResolvedProject {
  dir: string;
  title: string;
  config: ProjectConfig;
  schemaPath: string;
  gamePath: string;
  scenesDir: string;
  assetsDir: string;
  inkDir: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function resolveProject(
  dir: string,
  override?: ProjectConfig,
): Promise<ResolvedProject> {
  const root = resolve(dir);
  let config: ProjectConfig = override ?? {};
  if (!override) {
    const file = join(root, "ink.config.ts");
    if (await exists(file)) {
      const module = await import(toFileUrl(file).href + `?t=${Date.now()}`);
      config = module.default ?? {};
    }
  }
  return {
    dir: root,
    title: config.title ?? root.split("/").pop() ?? "ink",
    config,
    schemaPath: resolve(root, config.schema ?? "./schema.ts"),
    gamePath: resolve(root, config.game ?? "./game/main.blot"),
    scenesDir: resolve(root, config.scenes ?? "./scenes"),
    assetsDir: resolve(root, config.assets ?? "./assets"),
    inkDir: join(root, ".ink"),
  };
}

/**
 * Import schema.ts natively with a cache-busting query. Throws a readable
 * error when the module is broken or its default export is not a Schema.
 */
export async function loadSchema(path: string, bust: number): Promise<Schema> {
  const module = await import(toFileUrl(path).href + `?t=${bust}`);
  const schema = module.default as Schema | undefined;
  if (!schema || !Array.isArray(schema.components) || !schema.component) {
    throw new Error(
      `${path} must \`export default defineSchema({...})\``,
    );
  }
  return schema;
}

export { exists };

/** Directories the Vite dev server must be allowed to serve from. */
export function allowedDirs(project: ResolvedProject): string[] {
  const dirs = new Set<string>([project.dir]);
  dirs.add(resolve(dirname(new URL(import.meta.url).pathname), "../.."));
  for (const id of ["@mewhhaha/blot", "@mewhhaha/blot/guest"]) {
    try {
      const url = import.meta.resolve(id);
      if (url.startsWith("file:")) {
        dirs.add(resolve(new URL(".", url).pathname, ".."));
        dirs.add(new URL(".", url).pathname);
      }
    } catch {
      // not resolvable as a file; vite will resolve it from node_modules
    }
  }
  return [...dirs];
}
