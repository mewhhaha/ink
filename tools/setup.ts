/** Fetches and builds the pinned Blot compiler used by Ink's tooling. */
import { fileURLToPath, pathToFileURL } from "node:url";
import { cp } from "node:fs/promises";

import { revision } from "./toolchain.ts";
import { installCache, recoverCache, sealCache, validCache } from "./cache.ts";
export { revision };
export const blotRoot = new URL("../.cache/blot/", import.meta.url);

const cacheRoot = new URL("../.cache/", import.meta.url);
const required = [
  "zig-native/zig-out/bin/blotc",
  "std/prelude.blot",
  "std/array.blot",
  "std/list.blot",
  "std/vector.blot",
];

async function payloadFiles(root: URL): Promise<string[]> {
  const files = ["zig-native/zig-out/bin/blotc"];
  async function visit(directory: string) {
    for await (const item of Deno.readDir(new URL(directory, root))) {
      const path = `${directory}${item.name}`;
      if (item.isFile) files.push(path);
      if (item.isDirectory) await visit(`${path}/`);
    }
  }
  await visit("std/");
  return files;
}

async function isFile(url: URL): Promise<boolean> {
  try {
    return (await Deno.stat(url)).isFile;
  } catch {
    return false;
  }
}

export async function compilerCacheCurrent(root = blotRoot): Promise<boolean> {
  const binary = new URL("zig-native/zig-out/bin/blotc", root);
  const revisionFile = new URL(".setup-revision", root);
  if (!(await isFile(binary)) || !(await isFile(revisionFile))) return false;
  if ((await Deno.readTextFile(revisionFile)).trim() !== revision) return false;
  const stat = await Deno.stat(binary);
  if (stat.mode !== null && (stat.mode & 0o111) === 0) return false;
  if (!(await isFile(new URL(".setup-manifest.json", root)))) return false;
  try {
    return await validCache(root, revision, [
      ...required,
      ...await payloadFiles(root),
    ]);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function run(command: string, args: string[], cwd?: URL): Promise<void> {
  const result = await new Deno.Command(command, {
    args,
    cwd: cwd && fileURLToPath(cwd),
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!result.success) {
    throw new Error(`${command} exited with status ${result.code}`);
  }
}

export async function setup(): Promise<void> {
  await recoverCache(blotRoot);
  if (await compilerCacheCurrent()) {
    console.log(`Blot ${revision} is ready at ${fileURLToPath(blotRoot)}`);
    return;
  }

  await Deno.mkdir(cacheRoot, { recursive: true });
  const stagePath = await Deno.makeTempDir({
    dir: fileURLToPath(cacheRoot),
    prefix: "blot-setup-",
  });
  const stage = pathToFileURL(`${stagePath}/`);
  const source = new URL("source/", stage);
  const ready = new URL("ready/", stage);
  const archive = new URL("source.tar.gz", stage);

  try {
    const tarball = new URL(
      `https://github.com/mewhhaha/blot2/archive/${revision}.tar.gz`,
    );
    const response = await fetch(tarball);
    if (!response.ok || response.body === null) {
      throw new Error(
        `Could not download Blot ${revision}: HTTP ${response.status}`,
      );
    }
    await Deno.mkdir(source);
    await response.body.pipeTo(
      (await Deno.open(archive, { write: true, createNew: true })).writable,
    );
    await run("tar", [
      "-xzf",
      fileURLToPath(archive),
      "-C",
      fileURLToPath(source),
      "--strip-components=1",
    ]);

    const compilerRoot = new URL("zig-native/", source);
    const started = performance.now();
    await run("zig", [
      "build",
      "install",
      "-Doptimize=fast",
      "--prefix",
      "zig-out",
    ], compilerRoot);
    const buildMs = performance.now() - started;

    await Deno.mkdir(ready);
    await cp(
      fileURLToPath(new URL("std/", source)),
      fileURLToPath(new URL("std/", ready)),
      { recursive: true },
    );
    const sourceBinary = new URL("zig-native/zig-out/bin/blotc", source);
    const readyBinary = new URL("zig-native/zig-out/bin/blotc", ready);
    await Deno.mkdir(new URL("zig-native/zig-out/bin/", ready), {
      recursive: true,
    });
    await Deno.copyFile(sourceBinary, readyBinary);
    const binaryMode = (await Deno.stat(sourceBinary)).mode;
    if (binaryMode !== null) await Deno.chmod(readyBinary, binaryMode & 0o777);
    await Deno.writeTextFile(
      new URL(".setup-revision", ready),
      `${revision}\n`,
    );
    await sealCache(ready, revision, await payloadFiles(ready));
    if (!(await validCache(ready, revision, required))) {
      throw new Error("Incomplete compiler payload");
    }
    await installCache(ready, blotRoot);
    console.log(`Built Blot ${revision} in ${(buildMs / 1000).toFixed(1)}s`);
    console.log(`Blot compiler ready at ${fileURLToPath(blotRoot)}`);
  } finally {
    await Deno.remove(stagePath, { recursive: true }).catch(() => {});
  }
}

if (import.meta.main) await setup();
