import type { Observation, ObservationValue } from "./model.ts";
import type { ObservationSink } from "./sink.ts";

export interface RedactionPolicy {
  readonly sensitive_evidence_keys: ReadonlySet<string>;
  readonly replacement: string;
}

export const default_redaction_policy: RedactionPolicy = {
  sensitive_evidence_keys: new Set([
    "file_path",
    "game_text",
    "network_address",
  ]),
  replacement: "[redacted]",
};

export function create_redacting_sink(
  sink: ObservationSink,
  policy: RedactionPolicy = default_redaction_policy,
): ObservationSink {
  if (policy.replacement.length === 0) {
    throw new Error("observation redaction replacement cannot be empty");
  }
  const configured_policy: RedactionPolicy = {
    sensitive_evidence_keys: new Set(policy.sensitive_evidence_keys),
    replacement: policy.replacement,
  };
  return {
    record(observation) {
      sink.record(redact_observation(observation, configured_policy));
    },
  };
}

export function redact_observation(
  observation: Observation,
  policy: RedactionPolicy = default_redaction_policy,
): Observation {
  if (
    observation.type !== "diagnostic" && observation.type !== "event" &&
    observation.type !== "span"
  ) {
    return observation;
  }
  return {
    ...observation,
    evidence: redact_record(observation.evidence, policy),
  };
}

function redact_record(
  value: Readonly<Record<string, ObservationValue>>,
  policy: RedactionPolicy,
): Readonly<Record<string, ObservationValue>> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      policy.sensitive_evidence_keys.has(key)
        ? policy.replacement
        : redact_value(entry, policy),
    ]),
  );
}

function redact_value(
  value: ObservationValue,
  policy: RedactionPolicy,
): ObservationValue {
  if (Array.isArray(value)) {
    return value.map((entry) => redact_value(entry, policy));
  }
  if (value !== null && typeof value === "object") {
    return redact_record(
      value as Readonly<Record<string, ObservationValue>>,
      policy,
    );
  }
  return value;
}
