import { fileURLToPath } from "node:url";

interface FileProof {
  bytes: number;
  sha256: string;
}
interface Manifest {
  revision: string;
  files: Record<string, FileProof>;
}
const marker = ".setup-manifest.json";

async function proof(path: URL): Promise<FileProof> {
  const bytes = await Deno.readFile(path);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return {
    bytes: bytes.length,
    sha256: Array.from(hash, (value) => value.toString(16).padStart(2, "0"))
      .join(""),
  };
}

export async function cacheFiles(root: URL): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string) {
    for await (const item of Deno.readDir(new URL(directory, root))) {
      const path = `${directory}${item.name}`;
      if (item.isFile && path !== marker) files.push(path);
      if (item.isDirectory) await visit(`${path}/`);
    }
  }
  await visit("");
  return files;
}

export async function sealCache(root: URL, revision: string, files: string[]) {
  const manifest: Manifest = { revision, files: {} };
  for (const file of files) {
    manifest.files[file] = await proof(new URL(file, root));
  }
  await Deno.writeTextFile(
    new URL(marker, root),
    `${JSON.stringify(manifest)}\n`,
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function validCache(
  root: URL,
  revision: string,
  required: string[],
) {
  try {
    const manifest: unknown = JSON.parse(
      await Deno.readTextFile(new URL(marker, root)),
    );
    if (
      !record(manifest) || manifest.revision !== revision ||
      !record(manifest.files)
    ) return false;
    for (const file of required) {
      if (!Object.hasOwn(manifest.files, file)) return false;
    }
    for (const [file, expected] of Object.entries(manifest.files)) {
      if (
        !file || /[\\?#%]/.test(file) ||
        file.split("/").some((part) => !part || part === "." || part === "..")
      ) return false;
      if (
        !record(expected) || !Number.isSafeInteger(expected.bytes) ||
        Number(expected.bytes) < 0 || typeof expected.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(expected.sha256)
      ) return false;
      const actual = await proof(new URL(file, root));
      if (
        actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256
      ) return false;
    }
    return true;
  } catch (error) {
    if (
      error instanceof Deno.errors.NotFound ||
      error instanceof Deno.errors.IsADirectory || error instanceof SyntaxError
    ) {
      return false;
    }
    throw error;
  }
}

export async function recoverCache(root: URL) {
  const path = fileURLToPath(root).replace(/\/$/, "");
  try {
    await Deno.stat(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    try {
      await Deno.rename(`${path}.previous`, path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
}

/** The previous payload survives interruption until the staged payload is installed. */
export async function installCache(stage: URL, root: URL) {
  await recoverCache(root);
  const path = fileURLToPath(root).replace(/\/$/, "");
  const previous = `${path}.previous`;
  await Deno.remove(previous, { recursive: true }).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
  let hadPrevious = false;
  try {
    await Deno.rename(path, previous);
    hadPrevious = true;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  try {
    await Deno.rename(fileURLToPath(stage), path);
  } catch (error) {
    if (hadPrevious) await Deno.rename(previous, path);
    throw error;
  }
  if (hadPrevious) await Deno.remove(previous, { recursive: true });
}
