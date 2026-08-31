import { basename, dirname, resolve } from "node:path";

export const scenario_report_environment = "INK_SCENARIO_REPORT";

export type ScenarioAssertion =
  | { readonly id: string; readonly status: "passed" }
  | { readonly id: string; readonly status: "failed"; readonly reason: string };

export interface ScenarioAssertionReport {
  readonly version: 1;
  readonly assertions: readonly ScenarioAssertion[];
}

export function parse_scenario_assertion_report(
  source: string,
  path: string,
): ScenarioAssertionReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    throw new Error(`cannot parse scenario assertion report ${path}`, {
      cause,
    });
  }
  if (!is_record(parsed)) {
    throw new Error(`scenario assertion report ${path} must contain an object`);
  }
  expect_fields(
    parsed,
    ["assertions", "version"],
    `scenario assertion report ${path}`,
  );
  if (parsed.version !== 1) {
    throw new Error(
      `scenario assertion report ${path} version ${
        JSON.stringify(parsed.version)
      } must be 1`,
    );
  }
  if (!Array.isArray(parsed.assertions)) {
    throw new Error(
      `scenario assertion report ${path} field assertions must be an array`,
    );
  }

  const assertions = parsed.assertions.map((value, index) =>
    parse_assertion(value, `${path} assertions[${index}]`)
  );
  const ids = new Set<string>();
  for (const assertion of assertions) {
    if (ids.has(assertion.id)) {
      throw new Error(
        `scenario assertion report ${path} repeats assertion ${
          JSON.stringify(assertion.id)
        }`,
      );
    }
    ids.add(assertion.id);
  }
  return Object.freeze({
    version: 1,
    assertions: Object.freeze(assertions),
  });
}

export async function write_scenario_assertion_report(
  assertions: readonly ScenarioAssertion[],
  report_path = Deno.env.get(scenario_report_environment),
): Promise<void> {
  if (report_path === undefined || report_path.trim().length === 0) {
    throw new Error(
      `${scenario_report_environment} must name the scenario assertion report`,
    );
  }
  const source = `${JSON.stringify({ version: 1, assertions }, null, 2)}\n`;
  parse_scenario_assertion_report(source, report_path);

  const pending_path = resolve(
    dirname(report_path),
    `.${basename(report_path)}.${crypto.randomUUID()}.pending`,
  );
  try {
    await Deno.writeTextFile(pending_path, source);
    await Deno.rename(pending_path, report_path);
  } catch (cause) {
    try {
      await Deno.remove(pending_path);
    } catch (cleanup_cause) {
      if (!(cleanup_cause instanceof Deno.errors.NotFound)) {
        throw new AggregateError(
          [cause, cleanup_cause],
          `could not publish scenario assertion report ${report_path} or remove pending file ${pending_path}`,
        );
      }
    }
    throw cause;
  }
}

function parse_assertion(value: unknown, path: string): ScenarioAssertion {
  if (!is_record(value)) {
    throw new Error(`${path} must contain an object`);
  }
  const id = required_string(value, "id", path);
  if (value.status === "passed") {
    expect_fields(value, ["id", "status"], path);
    return Object.freeze({ id, status: "passed" });
  }
  if (value.status === "failed") {
    expect_fields(value, ["id", "reason", "status"], path);
    return Object.freeze({
      id,
      status: "failed",
      reason: required_string(value, "reason", path),
    });
  }
  throw new Error(
    `${path} status ${
      JSON.stringify(value.status)
    } must be "passed" or "failed"`,
  );
}

function required_string(
  record: Record<string, unknown>,
  field: string,
  path: string,
): string {
  const value = record[field];
  if (
    typeof value !== "string" || value.length === 0 || value.trim() !== value
  ) {
    throw new Error(
      `${path} field ${field} ${
        JSON.stringify(value)
      } must be a non-empty string without surrounding whitespace`,
    );
  }
  return value;
}

function expect_fields(
  record: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const actual = Object.keys(record).sort();
  const sorted_expected = [...expected].sort();
  if (
    actual.length === sorted_expected.length &&
    actual.every((field, index) => field === sorted_expected[index])
  ) {
    return;
  }
  throw new Error(
    `${path} fields ${JSON.stringify(actual)} must be ${
      JSON.stringify(sorted_expected)
    }`,
  );
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
