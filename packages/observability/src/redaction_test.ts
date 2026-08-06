import { assertEquals } from "@std/assert";
import type { Event } from "./model.ts";
import { redact_observation } from "./redaction.ts";

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
