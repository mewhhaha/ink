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
  "behavior",
  "brush",
  "camera",
  "changes",
  "character",
  "claims",
  "clock",
  "codec",
  "color",
  "contact",
  "daylight",
  "debug",
  "derived",
  "derived/keyed",
  "director",
  "ecs",
  "editor",
  "environment",
  "events",
  "field",
  "gizmos",
  "graphics",
  "handles",
  "history",
  "input",
  "input/keys",
  "joints",
  "lanes",
  "lighting",
  "locale",
  "logic",
  "math",
  "menu",
  "motion",
  "navigation",
  "navigation/ground",
  "navigation/locomotion",
  "navigation/lookahead",
  "navigation/packet",
  "noise",
  "orbit",
  "pages",
  "particles",
  "partition",
  "path",
  "pen/events",
  "pen/host",
  "pen/instances",
  "pen/locale",
  "pen/platform",
  "pen/program",
  "pen/retained",
  "pen/semantic",
  "pen/services",
  "pen/settings",
  "pen/simulation",
  "pen/workers",
  "persist",
  "persist/words",
  "physics",
  "physics/prepared",
  "picking",
  "placement",
  "polar",
  "preferences",
  "radial",
  "random",
  "render",
  "render/cache",
  "render/retained",
  "rig",
  "rigid",
  "scene",
  "schedule",
  "services",
  "services/typed",
  "shadow",
  "shapes",
  "sort",
  "sound",
  "spatial",
  "spatial/points",
  "spline",
  "statistics",
  "steering",
  "task_queue",
  "terrain",
  "text",
  "tiles",
  "time",
  "timeline",
  "transform",
  "tune",
  "tween",
  "ui",
  "ui/anchor",
  "ui/bubbles",
  "ui/console",
  "ui/dialog",
  "ui/font",
  "ui/outline",
  "ui/split_flap",
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
