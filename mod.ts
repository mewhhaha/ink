/** Source modules for Blot's `ink/` import namespace. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Map `ink/` here when this package is a local checkout. */
export const libraryUrl: URL = new URL("./lib/", import.meta.url);

/** Blot modules included in the package. */
export const modules: readonly string[] = [
  "animation",
  "arrays",
  "audio",
  "camera",
  "character",
  "color",
  "contact",
  "debug",
  "environment",
  "joints",
  "lighting",
  "math",
  "motion",
  "navigation",
  "noise",
  "particles",
  "physics",
  "placement",
  "random",
  "rigid",
  "scene",
  "shadow",
  "shapes",
  "sort",
  "spatial",
  "steering",
  "terrain",
  "tiles",
  "time",
  "transform",
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
    modules.map((name, i) =>
      writeFile(new URL(`${name}.blot`, destination), sources[i])
    ),
  );
  return destination;
}
