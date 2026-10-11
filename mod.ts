/** Source modules for Blot's `ink/` import namespace. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Map `ink/` here when this package is a local checkout. */
export const libraryUrl: URL = new URL("./lib/", import.meta.url);

/** Blot modules included in the package. */
export const modules: readonly string[] = [
  "animation",
  "app",
  "arrays",
  "audio",
  "brush",
  "camera",
  "character",
  "clock",
  "color",
  "contact",
  "daylight",
  "debug",
  "ecs",
  "editor",
  "environment",
  "events",
  "gizmos",
  "graphics",
  "input",
  "input/keys",
  "joints",
  "lanes",
  "lighting",
  "logic",
  "math",
  "menu",
  "motion",
  "navigation",
  "navigation/ground",
  "noise",
  "orbit",
  "particles",
  "path",
  "pen/events",
  "pen/host",
  "pen/platform",
  "pen/program",
  "pen/services",
  "pen/settings",
  "persist",
  "physics",
  "picking",
  "placement",
  "polar",
  "preferences",
  "random",
  "render",
  "rigid",
  "scene",
  "services",
  "shadow",
  "shapes",
  "sort",
  "sound",
  "spatial",
  "steering",
  "terrain",
  "text",
  "tiles",
  "time",
  "transform",
  "tune",
  "ui",
  "ui/font",
  "ui/tree",
  "ui/vocabulary",
  "view",
];

/** Copy the sources to a local directory for Blot's native compiler.
 * Works with local checkouts and packages imported over HTTP, including JSR. */
export async function installLibrary(directory: string | URL): Promise<URL> {
  let path: string;
  if (directory instanceof URL) path = fileURLToPath(directory);
  else path = directory;
  const destination = pathToFileURL(resolve(path) + sep);
  const sources = await Promise.all(modules.map(async (name) => {
    const source = new URL(`${name}.blot`, libraryUrl);
    if (source.protocol === "file:") return await readFile(source);
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`Cannot read ${source}: HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }));
  await mkdir(destination, { recursive: true });
  await Promise.all(
    modules.map(async (name, i) => {
      const file = new URL(`${name}.blot`, destination);
      await mkdir(dirname(fileURLToPath(file)), { recursive: true });
      await writeFile(file, sources[i]);
    }),
  );
  return destination;
}
