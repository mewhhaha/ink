import { assertEquals } from "@std/assert";
import type { Event } from "./model.ts";
import { create_redacting_sink, redact_observation } from "./redaction.ts";
import { create_test_sink } from "./sink.ts";

Deno.test("observation redaction removes sensitive evidence recursively", () => {
  const observation: Event = {
    type: "event",
    name: "connection",
    source: { subsystem: "networking" },
    timestamp_seconds: 1,
    context: {},
    evidence: {
      network_address: "192.0.2.4",
      nested: { file_path: "/private/save", count: 2 },
    },
  };
  assertEquals(redact_observation(observation), {
    ...observation,
    evidence: {
      network_address: "[redacted]",
      nested: { file_path: "[redacted]", count: 2 },
    },
  });
});

Deno.test("redacting sinks retain their configured sensitive keys", () => {
  const sensitive_keys = new Set(["secret"]);
  const recorded = create_test_sink();
  const sink = create_redacting_sink(recorded, {
    sensitive_evidence_keys: sensitive_keys,
    replacement: "hidden",
  });
  sensitive_keys.clear();

  sink.record({
    type: "event",
    name: "configuration",
    source: { subsystem: "test" },
    timestamp_seconds: 0,
    context: {},
    evidence: { secret: "value" },
  });
  const observation = recorded.observations()[0];
  assertEquals(
    observation.type === "event" ? observation.evidence : {},
    { secret: "hidden" },
  );
});
