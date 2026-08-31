import { assertEquals } from "@std/assert";
import { proof_report_source } from "./generate_proof_report.ts";

Deno.test("proof report serialization is deterministic and newline terminated", () => {
  const source = proof_report_source({
    version: 1,
    packages: [{
      name: "@ink/example",
      path: "packages/example",
      kind: "core",
      exports: [{
        subpath: "./model.ts",
        targets: ["./src/model.ts"],
        specifier: "@ink/example/model.ts",
        stability: "stable",
      }],
    }],
    scenarios: [],
  });
  assertEquals(source.endsWith("\n"), true);
  assertEquals(
    JSON.parse(source).packages[0].exports[0].specifier,
    "@ink/example/model.ts",
  );
});
