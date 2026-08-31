import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  workspace_proof_report,
  type WorkspaceProofReport,
} from "./check_workspace.ts";

const workspace_directory = fileURLToPath(new URL("../", import.meta.url));
const report_path = resolve(
  workspace_directory,
  "architecture/proof-report.json",
);

export function proof_report_source(report: WorkspaceProofReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

async function run(): Promise<void> {
  const unsupported_arguments = Deno.args.filter((argument) =>
    argument !== "--check"
  );
  if (unsupported_arguments.length > 0) {
    throw new Error(
      `unsupported proof report arguments: ${unsupported_arguments.join(", ")}`,
    );
  }
  const expected_source = proof_report_source(
    await workspace_proof_report(workspace_directory),
  );
  const check_only = Deno.args.includes("--check");
  if (!check_only) {
    await Deno.mkdir(dirname(report_path), { recursive: true });
    await Deno.writeTextFile(report_path, expected_source);
    console.log(`generated ${report_path}`);
    return;
  }

  let current_source: string;
  try {
    current_source = await Deno.readTextFile(report_path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) {
      throw new Error(`proof report ${report_path} is missing`, { cause });
    }
    throw cause;
  }
  if (current_source !== expected_source) {
    throw new Error(`proof report ${report_path} is stale`);
  }
  console.log(`checked ${report_path}`);
}

if (import.meta.main) await run();
