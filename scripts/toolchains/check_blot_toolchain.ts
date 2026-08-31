import { fileURLToPath } from "node:url";

interface LocalBlotToolchain {
  readonly kind: "local";
  readonly repository: string;
}

interface PinnedBlotToolchain {
  readonly kind: "pinned";
  readonly repository: string;
  readonly revision: string;
}

type BlotToolchain = LocalBlotToolchain | PinnedBlotToolchain;

const decoder = new TextDecoder();
const workspace_location = new URL("../../", import.meta.url);
const workspace_directory = fileURLToPath(workspace_location);
const toolchain_manifest = new URL(
  "../../toolchains/blot.json",
  import.meta.url,
);

export function parse_blot_toolchain(source: string): BlotToolchain {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`cannot parse ${toolchain_manifest.pathname}: ${error}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${toolchain_manifest.pathname} must contain an object`);
  }
  if (!("kind" in parsed) || !("repository" in parsed)) {
    throw new Error(
      `${toolchain_manifest.pathname} must declare "kind" and "repository"`,
    );
  }
  if (
    typeof parsed.repository !== "string" || parsed.repository.trim() === ""
  ) {
    throw new Error(
      `${toolchain_manifest.pathname} repository must be a non-empty string`,
    );
  }
  if (parsed.kind === "local") {
    return { kind: "local", repository: parsed.repository };
  }
  if (parsed.kind !== "pinned") {
    throw new Error(
      `${toolchain_manifest.pathname} kind must be "local" or "pinned"; received ${
        JSON.stringify(parsed.kind)
      }`,
    );
  }
  if (!("revision" in parsed) || typeof parsed.revision !== "string") {
    throw new Error(
      `${toolchain_manifest.pathname} pinned toolchain must declare "revision"`,
    );
  }
  if (!/^[0-9a-f]{40}$/u.test(parsed.revision)) {
    throw new Error(
      `${toolchain_manifest.pathname} revision must be a 40-character lowercase Git hash; received ${
        JSON.stringify(parsed.revision)
      }`,
    );
  }
  return {
    kind: "pinned",
    repository: parsed.repository,
    revision: parsed.revision,
  };
}

async function run_command(
  executable: string,
  arguments_: string[],
  working_directory: string,
): Promise<string> {
  const result = await new Deno.Command(executable, {
    args: arguments_,
    cwd: working_directory,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    const failure = decoder.decode(result.stderr).trim() ||
      decoder.decode(result.stdout).trim();
    throw new Error(
      `${executable} ${
        arguments_.join(" ")
      } failed in ${working_directory} with code ${result.code}: ${failure}`,
    );
  }
  return decoder.decode(result.stdout).trim();
}

async function check(): Promise<void> {
  const toolchain = parse_blot_toolchain(
    await Deno.readTextFile(toolchain_manifest),
  );
  const repository = fileURLToPath(
    new URL(`${toolchain.repository}/`, workspace_location),
  );
  const revision = await run_command(
    "git",
    ["rev-parse", "HEAD"],
    repository,
  );
  const status = await run_command(
    "git",
    ["status", "--short"],
    repository,
  );

  if (toolchain.kind === "pinned") {
    if (revision !== toolchain.revision) {
      throw new Error(
        `Blot checkout ${repository} is at ${revision}; expected ${toolchain.revision}`,
      );
    }
    if (status !== "") {
      throw new Error(
        `Blot checkout ${repository} has local changes:\n${status}`,
      );
    }
  }

  const local_change_count = status === "" ? 0 : status.split("\n").length;
  const revision_label = toolchain.kind === "local"
    ? `${revision}+${local_change_count}-local`
    : revision;
  console.log(`Blot toolchain ${revision_label}`);

  await run_command("pnpm", ["compiler:build"], repository);
  await run_command(
    "pnpm",
    ["compiler:build-development-profile"],
    repository,
  );
  console.log("Blot production and development compiler profiles built");

  await run_command("pnpm", ["package:build"], repository);
  await run_command("pnpm", ["package:check"], repository);
  console.log("Blot Node distribution built and verified");

  await run_command(
    Deno.execPath(),
    [
      "run",
      "--config",
      `${repository}/deno.json`,
      "--allow-read",
      "--allow-write",
      `${workspace_directory}/scripts/toolchains/verify_blot_distributions.mjs`,
      repository,
    ],
    repository,
  );
  console.log(
    "Blot compiler distributions and incremental activation verified",
  );

  await run_command("just", ["check"], repository);
  console.log("Blot authoritative checks passed");

  await run_command("just", ["test"], repository);
  console.log("Blot authoritative tests passed");

  await run_command(
    Deno.execPath(),
    [
      "test",
      "--config",
      `${workspace_directory}/deno.json`,
      "--allow-read",
      "--allow-write",
      "--allow-run=deno",
      `${workspace_directory}/packages/blot/abi_contract_test.ts`,
    ],
    workspace_directory,
  );
  console.log("Blot ABI fixture compiled, instantiated, and executed");
}

if (import.meta.main) await check();
