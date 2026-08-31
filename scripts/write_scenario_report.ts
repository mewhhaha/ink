import {
  type ScenarioAssertion,
  write_scenario_assertion_report,
} from "./scenario_report.ts";

export function parse_scenario_report_arguments(
  arguments_: readonly string[],
): readonly ScenarioAssertion[] {
  const assertions: ScenarioAssertion[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index];
    if (option !== "--passed") {
      throw new Error(
        `scenario report argument ${index + 1} ${
          JSON.stringify(option)
        } must be "--passed"`,
      );
    }
    const id = arguments_[index + 1];
    if (
      id === undefined || id.length === 0 || id.trim() !== id ||
      id.startsWith("--")
    ) {
      throw new Error(
        `scenario report --passed argument ${index + 2} ${
          JSON.stringify(id)
        } must be a non-empty assertion ID without surrounding whitespace`,
      );
    }
    if (ids.has(id)) {
      throw new Error(
        `scenario report arguments repeat assertion ${JSON.stringify(id)}`,
      );
    }
    ids.add(id);
    assertions.push(Object.freeze({ id, status: "passed" }));
  }
  return Object.freeze(assertions);
}

if (import.meta.main) {
  await write_scenario_assertion_report(
    parse_scenario_report_arguments(Deno.args),
  );
}
