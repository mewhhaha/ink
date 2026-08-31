import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse_blot_toolchain } from "./toolchains/check_blot_toolchain.ts";

const workspace_directory = fileURLToPath(new URL("../", import.meta.url));
const workspace_location = new URL("../", import.meta.url);
const blot_toolchain_manifest = new URL(
  "../toolchains/blot.json",
  import.meta.url,
);
const decoder = new TextDecoder();

export interface RepositoryState {
  readonly fingerprint: string;
  readonly status: string;
}

export function repository_state_difference(
  before: RepositoryState,
  after: RepositoryState,
): string | undefined {
  if (
    before.fingerprint === after.fingerprint && before.status === after.status
  ) return undefined;
  return `repository contents changed during verification\nbefore status:\n${
    before.status || "(clean)"
  }\nafter status:\n${
    after.status || "(clean)"
  }\nbefore fingerprint: ${before.fingerprint}\nafter fingerprint: ${after.fingerprint}`;
}

async function git_output(
  directory: string,
  arguments_: readonly string[],
): Promise<Uint8Array> {
  const result = await new Deno.Command("git", {
    args: [...arguments_],
    cwd: directory,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (result.success) return result.stdout;

  const evidence = decoder.decode(result.stderr).trim() ||
    decoder.decode(result.stdout).trim() || "no command output";
  throw new Error(
    `git ${
      arguments_.join(" ")
    } failed in ${directory} with code ${result.code}: ${evidence}`,
  );
}

async function repository_state(directory: string): Promise<RepositoryState> {
  const [status_bytes, tracked_changes, untracked_bytes] = await Promise.all([
    git_output(directory, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]),
    git_output(directory, ["diff", "--binary", "--no-ext-diff", "HEAD"]),
    git_output(directory, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]),
  ]);
  const untracked_paths = decoder.decode(untracked_bytes).split("\0").filter(
    (path) => path.length > 0,
  ).sort();
  const untracked = [];
  for (const path of untracked_paths) {
    const absolute_path = resolve(directory, path);
    const file_state = await Deno.lstat(absolute_path);
    const contents = file_state.isSymlink
      ? new TextEncoder().encode(await Deno.readLink(absolute_path))
      : await Deno.readFile(absolute_path);
    untracked.push({
      path,
      type: file_state.isSymlink ? "symlink" : "file",
      digest: await sha256(contents),
    });
  }
  const fingerprint_source = JSON.stringify({
    tracked: await sha256(tracked_changes),
    untracked,
  });
  return Object.freeze({
    fingerprint: await sha256(new TextEncoder().encode(fingerprint_source)),
    status: decoder.decode(status_bytes).trim(),
  });
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copied = new Uint8Array(bytes.byteLength);
  copied.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copied);
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function run_gate(script: string): Promise<void> {
  console.log(`\n> pnpm ${script}`);
  const command = new Deno.Command("pnpm", {
    args: [script],
    cwd: workspace_directory,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const status = await command.status;
  if (!status.success) {
    throw new Error(`pnpm ${script} exited with code ${status.code}`);
  }
}

async function verify_workspace(): Promise<void> {
  const toolchain = parse_blot_toolchain(
    await Deno.readTextFile(blot_toolchain_manifest),
  );
  const toolchain_directory = fileURLToPath(
    new URL(`${toolchain.repository}/`, workspace_location),
  );
  const [workspace_before, toolchain_before] = await Promise.all([
    repository_state(workspace_directory),
    repository_state(toolchain_directory),
  ]);
  for (const script of ["check", "test", "build", "test:browser"]) {
    await run_gate(script);
  }
  const [workspace_after, toolchain_after] = await Promise.all([
    repository_state(workspace_directory),
    repository_state(toolchain_directory),
  ]);
  const workspace_difference = repository_state_difference(
    workspace_before,
    workspace_after,
  );
  if (workspace_difference !== undefined) {
    throw new Error(`Ink ${workspace_difference}`);
  }
  const toolchain_difference = repository_state_difference(
    toolchain_before,
    toolchain_after,
  );
  if (toolchain_difference !== undefined) {
    throw new Error(`Blot toolchain ${toolchain_difference}`);
  }
  console.log(
    "verified Ink and its Blot toolchain without repository-status changes",
  );
}

if (import.meta.main) await verify_workspace();
