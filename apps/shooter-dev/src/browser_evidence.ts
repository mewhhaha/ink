import type { BlotHostEffect } from "@ink/blot/protocol.ts";
import type { BlotPresentation } from "@ink/blot/runtime.ts";
import type {
  RasterAntiAliasingResult,
  Renderer,
  RenderFrameResult,
  RenderPickResult,
} from "@ink/rendering/renderer.ts";
import type { RuntimeRevision } from "@ink/runtime/session.ts";
import type { ShooterAudioHostEvidence } from "./audio.ts";
import type { ShooterObservationBoundary } from "./runtime.ts";

export type ShooterRevisionEvidence =
  | { readonly type: "initial" }
  | {
    readonly type: "advanced";
    readonly sequence: number;
    readonly snapshot_checksum: string;
  };

export interface ShooterRendererEvidence {
  readonly adapter_description: string;
  readonly status:
    | "ready"
    | "path_tracing_unavailable"
    | "device_error"
    | "device_lost";
  readonly validation_error_count: number;
  readonly frame_type: "raster";
  readonly anti_aliasing: RasterAntiAliasingResult;
  readonly submitted_object_ids: readonly string[];
  readonly center_pick: string;
}

export interface ShooterObservationEvidence {
  readonly capacity: number;
  readonly retained: number;
  readonly dropped: number;
  readonly redacted_game_text: string;
  readonly redacted_debugger_message: string;
}

export interface ShooterAudioEvidence {
  readonly id: string;
  readonly cue: string;
}

export interface ShooterBrowserEvidence {
  readonly version: 2;
  readonly runtime: ShooterRevisionEvidence;
  readonly presentation_source: string;
  readonly renderer: ShooterRendererEvidence;
  readonly observations: ShooterObservationEvidence;
  readonly audio: readonly ShooterAudioEvidence[];
  readonly audio_host: ShooterAudioHostEvidence;
}

export function serialize_shooter_presentation(
  presentation: BlotPresentation,
): string {
  return JSON.stringify(presentation);
}

export function shooter_browser_evidence(
  presentation: BlotPresentation,
  revision: RuntimeRevision | undefined,
  renderer: Renderer,
  frame: RenderFrameResult,
  pick: RenderPickResult,
  observations: ShooterObservationBoundary,
  audio: readonly BlotHostEffect[],
  audio_host: ShooterAudioHostEvidence,
): ShooterBrowserEvidence {
  const retained = observations.log.observations();
  const redacted_presentation = [...retained].reverse().find((observation) =>
    observation.type === "event" &&
    observation.name === "shooter.browser.presentation"
  );
  const redacted_game_text = redacted_presentation?.type === "event"
    ? redacted_presentation.evidence.game_text
    : undefined;
  if (typeof redacted_game_text !== "string") {
    throw new Error(
      `shooter browser observation game text ${
        JSON.stringify(redacted_game_text)
      } must be text`,
    );
  }
  const redacted_debugger_message = [...observations.debugger_entries()]
    .reverse()
    .find(({ message }) => message.includes("shooter.browser.presentation"))
    ?.message.slice(0, 512);
  if (redacted_debugger_message === undefined) {
    throw new Error(
      "shooter browser debugger omitted its presentation observation",
    );
  }
  const runtime: ShooterRevisionEvidence = revision === undefined
    ? { type: "initial" }
    : {
      type: "advanced",
      sequence: revision.sequence,
      snapshot_checksum: revision.snapshot_checksum,
    };
  if (frame.type !== "raster") {
    throw new Error(
      `shooter renderer produced unexpected ${frame.type} frame evidence`,
    );
  }
  return Object.freeze({
    version: 2,
    runtime: Object.freeze(runtime),
    presentation_source: serialize_shooter_presentation(presentation),
    renderer: Object.freeze({
      adapter_description: renderer.adapter_description,
      status: renderer.status.type,
      validation_error_count: renderer.validation_error_count,
      frame_type: frame.type,
      anti_aliasing: frame.anti_aliasing,
      submitted_object_ids: Object.freeze(
        frame.visibility.submitted.map(({ object_id }) => object_id),
      ),
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

export function serialize_shooter_browser_evidence(
  evidence: ShooterBrowserEvidence,
): string {
  return JSON.stringify(evidence);
}

export function parse_shooter_browser_evidence(
  source: string,
): ShooterBrowserEvidence {
  const root = record(JSON.parse(source), "shooter browser evidence");
  if (root.version !== 2) {
    throw new Error(
      `shooter browser evidence version ${
        JSON.stringify(root.version)
      } is unsupported`,
    );
  }
  const runtime = parse_revision(
    record(root.runtime, "shooter browser runtime evidence"),
  );
  const renderer = record(root.renderer, "shooter browser renderer evidence");
  const observations = record(
    root.observations,
    "shooter browser observation evidence",
  );
  const capacity = positive_integer(
    observations.capacity,
    "shooter observation capacity",
  );
  const retained = nonnegative_integer(
    observations.retained,
    "shooter retained observations",
  );
  const audio_host = record(root.audio_host, "shooter browser audio host");
  if (retained > capacity) {
    throw new Error(
      `shooter retained observations ${retained} exceed capacity ${capacity}`,
    );
  }
  return Object.freeze({
    version: 2,
    runtime,
    presentation_source: text(
      root.presentation_source,
      "shooter browser presentation source",
    ),
    renderer: Object.freeze({
      adapter_description: text(
        renderer.adapter_description,
        "shooter renderer adapter",
      ),
      status: one_of(
        renderer.status,
        ["ready", "path_tracing_unavailable", "device_error", "device_lost"],
        "shooter renderer status",
      ),
      validation_error_count: nonnegative_integer(
        renderer.validation_error_count,
        "shooter renderer validation errors",
      ),
      frame_type: one_of(
        renderer.frame_type,
        ["raster"],
        "shooter renderer frame type",
      ),
      anti_aliasing: parse_raster_anti_aliasing(
        record(
          renderer.anti_aliasing,
          "shooter renderer anti-aliasing evidence",
        ),
      ),
      submitted_object_ids: Object.freeze(
        array(
          renderer.submitted_object_ids,
          "shooter renderer submitted object ids",
        ).map((id, index) =>
          text(id, `shooter renderer submitted object id[${index}]`)
        ),
      ),
      center_pick: text(renderer.center_pick, "shooter renderer center pick"),
    }),
    observations: Object.freeze({
      capacity,
      retained,
      dropped: nonnegative_integer(
        observations.dropped,
        "shooter dropped observations",
      ),
      redacted_game_text: text(
        observations.redacted_game_text,
        "shooter redacted game text",
      ),
      redacted_debugger_message: text(
        observations.redacted_debugger_message,
        "shooter redacted debugger message",
      ),
    }),
    audio: Object.freeze(
      array(root.audio, "shooter browser audio").map((entry, index) => {
        const effect = record(entry, `shooter browser audio[${index}]`);
        return Object.freeze({
          id: text(effect.id, `shooter browser audio[${index}] id`),
          cue: text(effect.cue, `shooter browser audio[${index}] cue`),
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
        "shooter browser audio host state",
      ),
      submitted_cues: nonnegative_integer(
        audio_host.submitted_cues,
        "shooter browser submitted audio cues",
      ),
    }),
  });
}

function parse_raster_anti_aliasing(
  value: Readonly<Record<string, unknown>>,
): RasterAntiAliasingResult {
  const type = one_of(
    value.type,
    ["none", "fxaa", "taa"],
    "shooter renderer anti-aliasing type",
  );
  if (type !== "taa") return Object.freeze({ type });
  return Object.freeze({
    type,
    accumulation: one_of(
      value.accumulation,
      ["reset", "continued"],
      "shooter renderer temporal accumulation",
    ),
    reset_reasons: Object.freeze(
      array(
        value.reset_reasons,
        "shooter renderer temporal reset reasons",
      ).map((reason, index) =>
        one_of(
          reason,
          ["initial", "camera", "scene", "viewport", "technique"] as const,
          `shooter renderer temporal reset reason[${index}]`,
        )
      ),
    ),
  });
}

function parse_revision(
  value: Readonly<Record<string, unknown>>,
): ShooterRevisionEvidence {
  if (value.type === "initial") return Object.freeze({ type: "initial" });
  if (value.type !== "advanced") {
    throw new Error(
      `shooter browser runtime type ${
        JSON.stringify(value.type)
      } is unsupported`,
    );
  }
  const snapshot_checksum = text(
    value.snapshot_checksum,
    "shooter snapshot checksum",
  );
  if (!/^[0-9a-f]{64}$/u.test(snapshot_checksum)) {
    throw new Error(
      `shooter snapshot checksum ${
        JSON.stringify(snapshot_checksum)
      } must contain 64 lowercase hexadecimal characters`,
    );
  }
  return Object.freeze({
    type: "advanced",
    sequence: nonnegative_integer(value.sequence, "shooter sequence"),
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
