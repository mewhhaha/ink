import { assertEquals, assertThrows } from "@std/assert";
import { parse_scenario_report_arguments } from "./write_scenario_report.ts";

Deno.test("scenario report CLI parses passed assertion IDs", () => {
  assertEquals(parse_scenario_report_arguments([]), []);
  assertEquals(
    parse_scenario_report_arguments([
      "--passed",
      "headless:gate-blocks-before-unlock",
      "--passed",
      "browser:gate-renders-open",
    ]),
    [
      { id: "headless:gate-blocks-before-unlock", status: "passed" },
      { id: "browser:gate-renders-open", status: "passed" },
    ],
  );
});

Deno.test("scenario report CLI rejects malformed and duplicate arguments", () => {
  for (
    const test_case of [
      {
        arguments: ["--unknown", "headless:gate-unlocks"],
        message: 'argument 1 "--unknown" must be "--passed"',
      },
      {
        arguments: ["--passed"],
        message: "--passed argument 2 undefined",
      },
      {
        arguments: ["--passed", " headless:gate-unlocks"],
        message: 'argument 2 " headless:gate-unlocks"',
      },
      {
        arguments: [
          "--passed",
          "headless:gate-unlocks",
          "--passed",
          "headless:gate-unlocks",
        ],
        message: 'repeat assertion "headless:gate-unlocks"',
      },
    ]
  ) {
    assertThrows(
      () => parse_scenario_report_arguments(test_case.arguments),
      Error,
      test_case.message,
    );
  }
});
