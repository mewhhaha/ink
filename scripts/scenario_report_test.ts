import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  parse_scenario_assertion_report,
  write_scenario_assertion_report,
} from "./scenario_report.ts";

Deno.test("scenario reports parse passed and failed assertions", () => {
  assertEquals(
    parse_scenario_assertion_report(
      JSON.stringify({
        version: 1,
        assertions: [
          { id: "headless:gate-unlocks", status: "passed" },
          {
            id: "browser:gate-renders",
            status: "failed",
            reason: "gate remained visible",
          },
        ],
      }),
      "report.json",
    ),
    {
      version: 1,
      assertions: [
        { id: "headless:gate-unlocks", status: "passed" },
        {
          id: "browser:gate-renders",
          status: "failed",
          reason: "gate remained visible",
        },
      ],
    },
  );
});

Deno.test("scenario reports reject duplicate assertions and malformed variants", () => {
  assertThrows(
    () =>
      parse_scenario_assertion_report(
        JSON.stringify({
          version: 1,
          assertions: [
            { id: "headless:gate-unlocks", status: "passed" },
            { id: "headless:gate-unlocks", status: "passed" },
          ],
        }),
        "report.json",
      ),
    Error,
    'repeats assertion "headless:gate-unlocks"',
  );
  assertThrows(
    () =>
      parse_scenario_assertion_report(
        JSON.stringify({
          version: 1,
          assertions: [{
            id: "browser:gate-renders",
            status: "failed",
          }],
        }),
        "report.json",
      ),
    Error,
    "fields",
  );
});

Deno.test("scenario report writer requires an explicit destination", async () => {
  await assertRejects(
    () =>
      write_scenario_assertion_report(
        [{ id: "headless:gate-unlocks", status: "passed" }],
        "",
      ),
    Error,
    "INK_SCENARIO_REPORT",
  );
});
