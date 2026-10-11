/** Fetches and builds the pinned Blot compiler used by Ink's tooling. */
import { fileURLToPath, pathToFileURL } from "node:url";
import { cp } from "node:fs/promises";

export const revision = "86a527b97c32331993c4a006da2c982a7336c365";
export const blotRoot = new URL("../.cache/blot/", import.meta.url);

const cacheRoot = new URL("../.cache/", import.meta.url);
const binary = new URL("zig-native/zig-out/bin/blotc", blotRoot);
const revisionFile = new URL(".setup-revision", blotRoot);

async function isFile(url: URL): Promise<boolean> {
  try {
    return (await Deno.stat(url)).isFile;
  } catch {
    return false;
  }
}

async function isCurrent(): Promise<boolean> {
  if (!(await isFile(binary)) || !(await isFile(revisionFile))) return false;
  return (await Deno.readTextFile(revisionFile)).trim() === revision;
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
  if (await isCurrent()) {
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
  let backupPath: string | undefined;

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
    if (await Deno.stat(blotRoot).then(() => true, () => false)) {
      backupPath = `${fileURLToPath(cacheRoot)}blot-old-${crypto.randomUUID()}`;
      await Deno.rename(fileURLToPath(blotRoot), backupPath);
    }
    try {
      await Deno.rename(fileURLToPath(ready), fileURLToPath(blotRoot));
    } catch (error) {
      if (backupPath !== undefined) {
        await Deno.rename(backupPath, fileURLToPath(blotRoot));
        backupPath = undefined;
      }
      throw error;
    }
    if (backupPath !== undefined) {
      await Deno.remove(backupPath, { recursive: true });
      backupPath = undefined;
    }
    console.log(`Built Blot ${revision} in ${(buildMs / 1000).toFixed(1)}s`);
    console.log(`Blot compiler ready at ${fileURLToPath(blotRoot)}`);
  } finally {
    await Deno.remove(stagePath, { recursive: true }).catch(() => {});
  }
}

if (import.meta.main) await setup();
