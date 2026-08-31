import { write_scenario_assertion_report } from "./scenario_report.ts";

export interface CapabilityScenarioCommand {
  readonly arguments: readonly string[];
  readonly executable: string;
}

export function parse_capability_scenario_command(
  arguments_: readonly string[],
): CapabilityScenarioCommand {
  if (arguments_[0] !== "--") {
    throw new Error(
      `capability scenario command argument 1 ${
        JSON.stringify(arguments_[0])
      } must be "--"; capability demos cannot declare proof assertions`,
    );
  }
  const executable = arguments_[1];
  if (
    executable === undefined || executable.length === 0 ||
    executable.trim() !== executable
  ) {
    throw new Error(
      `capability scenario command executable ${
        JSON.stringify(executable)
      } must be a non-empty string without surrounding whitespace`,
    );
  }
  return Object.freeze({
    arguments: Object.freeze(arguments_.slice(2)),
    executable,
  });
}

if (import.meta.main) {
  const invocation = parse_capability_scenario_command(Deno.args);
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(invocation.executable, {
      args: [...invocation.arguments],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
  } catch (cause) {
    throw new Error(
      `capability scenario command ${
        JSON.stringify([invocation.executable, ...invocation.arguments])
      } could not start`,
      { cause },
    );
  }
  const status = await child.status;
  if (!status.success) {
    const outcome = status.signal === null
      ? `exit code ${status.code}`
      : `signal ${status.signal}`;
    throw new Error(
      `capability scenario command ${
        JSON.stringify([invocation.executable, ...invocation.arguments])
      } failed with ${outcome}`,
    );
  }
  await write_scenario_assertion_report([]);
}
