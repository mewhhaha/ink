import type { BlotHostEffect } from "@ink/blot/protocol.ts";
import type { BlotPresentation } from "@ink/blot/runtime.ts";
import type {
  Renderer,
  RenderFrameResult,
  RenderPickResult,
} from "@ink/rendering/renderer.ts";
import type { RuntimeRevision } from "@ink/runtime/session.ts";
import type { VehicleAudioHostEvidence } from "./audio.ts";
import type { VehicleObservationBoundary } from "./runtime.ts";

export type VehicleRevisionEvidence =
  | { readonly type: "initial" }
  | {
    readonly type: "advanced";
    readonly sequence: number;
    readonly snapshot_checksum: string;
  };

export interface VehicleRendererEvidence {
  readonly adapter_description: string;
  readonly status:
    | "ready"
    | "path_tracing_unavailable"
    | "device_error"
    | "device_lost";
  readonly validation_error_count: number;
  readonly frame_type: "raster" | "path_traced";
  readonly center_pick: string;
}

export interface VehicleObservationEvidence {
  readonly capacity: number;
  readonly retained: number;
  readonly dropped: number;
  readonly redacted_game_text: string;
  readonly redacted_debugger_message: string;
}

export interface VehicleAudioEvidence {
  readonly id: string;
  readonly cue: string;
}

export interface VehicleBrowserEvidence {
  readonly version: 2;
  readonly runtime: VehicleRevisionEvidence;
  readonly presentation_source: string;
  readonly renderer: VehicleRendererEvidence;
  readonly observations: VehicleObservationEvidence;
  readonly audio: readonly VehicleAudioEvidence[];
  readonly audio_host: VehicleAudioHostEvidence;
}

export function serialize_vehicle_presentation(
  presentation: BlotPresentation,
): string {
  return JSON.stringify(presentation);
}

export function vehicle_browser_evidence(
  presentation: BlotPresentation,
  revision: RuntimeRevision | undefined,
  renderer: Renderer,
  frame: RenderFrameResult,
  pick: RenderPickResult,
  observations: VehicleObservationBoundary,
  audio: readonly BlotHostEffect[],
  audio_host: VehicleAudioHostEvidence,
): VehicleBrowserEvidence {
  const retained = observations.log.observations();
  const redacted_presentation = [...retained].reverse().find((observation) =>
    observation.type === "event" &&
    observation.name === "vehicle.browser.presentation"
  );
  const redacted_game_text = redacted_presentation?.type === "event"
    ? redacted_presentation.evidence.game_text
    : undefined;
  if (typeof redacted_game_text !== "string") {
    throw new Error(
      `vehicle browser observation game text ${
        JSON.stringify(redacted_game_text)
      } must be text`,
    );
  }
  const redacted_debugger_message = [...observations.debugger_entries()]
    .reverse()
    .find(({ message }) => message.includes("vehicle.browser.presentation"))
    ?.message.slice(0, 512);
  if (redacted_debugger_message === undefined) {
    throw new Error(
      "vehicle browser debugger omitted its presentation observation",
    );
  }
  const runtime: VehicleRevisionEvidence = revision === undefined
    ? { type: "initial" }
    : {
      type: "advanced",
      sequence: revision.sequence,
      snapshot_checksum: revision.snapshot_checksum,
    };
  return Object.freeze({
    version: 2,
    runtime: Object.freeze(runtime),
    presentation_source: serialize_vehicle_presentation(presentation),
    renderer: Object.freeze({
      adapter_description: renderer.adapter_description,
      status: renderer.status.type,
      validation_error_count: renderer.validation_error_count,
      frame_type: frame.type,
      center_pick: pick.type === "hit" ? pick.object_id : "miss",
    }),
    observations: Object.freeze({
      capacity: observations.log.capacity,
      retained: retained.length,
      dropped: observations.log.dropped(),
      redacted_game_text,
      redacted_debugger_message,
    }),
    audio: Object.freeze(
      audio.map(({ id, cue }) => Object.freeze({ id, cue: String(cue) })),
    ),
    audio_host: Object.freeze({ ...audio_host }),
  });
}

export function serialize_vehicle_browser_evidence(
  evidence: VehicleBrowserEvidence,
): string {
  return JSON.stringify(evidence);
}

export function parse_vehicle_browser_evidence(
  source: string,
): VehicleBrowserEvidence {
  const root = record(JSON.parse(source), "vehicle browser evidence");
  if (root.version !== 2) {
    throw new Error(
      `vehicle browser evidence version ${
        JSON.stringify(root.version)
      } is unsupported`,
    );
  }
  const runtime = parse_revision(
    record(root.runtime, "vehicle browser runtime evidence"),
  );
  const renderer = record(root.renderer, "vehicle browser renderer evidence");
  const observations = record(
    root.observations,
    "vehicle browser observation evidence",
  );
  const capacity = positive_integer(
    observations.capacity,
    "vehicle observation capacity",
  );
  const retained = nonnegative_integer(
    observations.retained,
    "vehicle retained observations",
  );
  if (retained > capacity) {
    throw new Error(
      `vehicle retained observations ${retained} exceed capacity ${capacity}`,
    );
  }
  const audio_host = record(root.audio_host, "vehicle browser audio host");
  return Object.freeze({
    version: 2,
    runtime,
    presentation_source: text(
      root.presentation_source,
      "vehicle browser presentation source",
    ),
    renderer: Object.freeze({
      adapter_description: text(
        renderer.adapter_description,
        "vehicle renderer adapter",
      ),
      status: one_of(
        renderer.status,
        ["ready", "path_tracing_unavailable", "device_error", "device_lost"],
        "vehicle renderer status",
      ),
      validation_error_count: nonnegative_integer(
        renderer.validation_error_count,
        "vehicle renderer validation errors",
      ),
      frame_type: one_of(
        renderer.frame_type,
        ["raster", "path_traced"],
        "vehicle renderer frame type",
      ),
      center_pick: text(renderer.center_pick, "vehicle renderer center pick"),
    }),
    observations: Object.freeze({
      capacity,
      retained,
      dropped: nonnegative_integer(
        observations.dropped,
        "vehicle dropped observations",
      ),
      redacted_game_text: text(
        observations.redacted_game_text,
        "vehicle redacted game text",
      ),
      redacted_debugger_message: text(
        observations.redacted_debugger_message,
        "vehicle redacted debugger message",
      ),
    }),
    audio: Object.freeze(
      array(root.audio, "vehicle browser audio").map((entry, index) => {
        const effect = record(entry, `vehicle browser audio[${index}]`);
        return Object.freeze({
          id: text(effect.id, `vehicle browser audio[${index}] id`),
          cue: text(effect.cue, `vehicle browser audio[${index}] cue`),
        });
      }),
    ),
    audio_host: Object.freeze({
      state: one_of(
        audio_host.state,
        [
          "unavailable",
          "blocked",
          "suspended",
          "running",
          "interrupted",
          "recovering",
        ],
        "vehicle browser audio host state",
      ),
      submitted_cues: nonnegative_integer(
        audio_host.submitted_cues,
        "vehicle browser submitted audio cues",
      ),
    }),
  });
}

function parse_revision(
  value: Readonly<Record<string, unknown>>,
): VehicleRevisionEvidence {
  if (value.type === "initial") return Object.freeze({ type: "initial" });
  if (value.type !== "advanced") {
    throw new Error(
      `vehicle browser runtime type ${
        JSON.stringify(value.type)
      } is unsupported`,
    );
  }
  const snapshot_checksum = text(
    value.snapshot_checksum,
    "vehicle snapshot checksum",
  );
  if (!/^[0-9a-f]{64}$/u.test(snapshot_checksum)) {
    throw new Error(
      `vehicle snapshot checksum ${
        JSON.stringify(snapshot_checksum)
      } must contain 64 lowercase hexadecimal characters`,
    );
  }
  return Object.freeze({
    type: "advanced",
    sequence: nonnegative_integer(value.sequence, "vehicle sequence"),
    snapshot_checksum,
  });
}

function record(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} ${JSON.stringify(value)} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} ${JSON.stringify(value)} must be an array`);
  }
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} ${JSON.stringify(value)} must be text`);
  }
  return value;
}

function nonnegative_integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `${label} ${JSON.stringify(value)} must be a nonnegative integer`,
    );
  }
  return value;
}

function positive_integer(value: unknown, label: string): number {
  const parsed = nonnegative_integer(value, label);
  if (parsed === 0) {
    throw new Error(`${label} ${JSON.stringify(value)} must be positive`);
  }
  return parsed;
}

function one_of<const Value extends string>(
  value: unknown,
  choices: readonly Value[],
  label: string,
): Value {
  if (typeof value === "string") {
    const match = choices.find((choice) => choice === value);
    if (match !== undefined) return match;
  }
  throw new Error(
    `${label} ${JSON.stringify(value)} must be one of ${choices.join(", ")}`,
  );
}
