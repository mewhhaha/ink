import type { BlotHostEffect } from "@ink/blot/protocol.ts";
import type { BlotPresentation } from "@ink/blot/runtime.ts";
import type {
  Renderer,
  RenderFrameResult,
  RenderPickResult,
} from "@ink/rendering/renderer.ts";
import type { RuntimeRevision } from "@ink/runtime/session.ts";
import type { RoleplayingAudioSnapshot } from "./audio.ts";
import type { RoleplayingObservationBoundary } from "./runtime.ts";

export type RoleplayingRevisionEvidence =
  | { readonly type: "initial" }
  | {
    readonly type: "advanced";
    readonly sequence: number;
    readonly snapshot_checksum: string;
  };

export interface RoleplayingRendererEvidence {
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

export interface RoleplayingObservationEvidence {
  readonly capacity: number;
  readonly retained: number;
  readonly dropped: number;
  readonly redacted_game_text: string;
  readonly redacted_debugger_message: string;
}

export interface RoleplayingAudioEvidence {
  readonly id: string;
  readonly cue: string;
}

export interface RoleplayingAudioHostEvidence {
  readonly accepted: readonly {
    readonly cue: string;
    readonly sequence: number;
  }[];
  readonly command_capacity: number;
  readonly retained_commands: number;
  readonly state:
    | "unavailable"
    | "blocked"
    | "suspended"
    | "running"
    | "interrupted"
    | "recovering";
}

export interface RoleplayingBrowserEvidence {
  readonly version: 1;
  readonly runtime: RoleplayingRevisionEvidence;
  readonly presentation_source: string;
  readonly renderer: RoleplayingRendererEvidence;
  readonly observations: RoleplayingObservationEvidence;
  readonly audio: readonly RoleplayingAudioEvidence[];
  readonly audio_host: RoleplayingAudioHostEvidence;
}

export function serialize_roleplaying_presentation(
  presentation: BlotPresentation,
): string {
  return JSON.stringify(presentation);
}

export function roleplaying_browser_evidence(
  presentation: BlotPresentation,
  revision: RuntimeRevision | undefined,
  renderer: Renderer,
  frame: RenderFrameResult,
  pick: RenderPickResult,
  observations: RoleplayingObservationBoundary,
  audio: readonly BlotHostEffect[],
  audio_host: RoleplayingAudioSnapshot,
): RoleplayingBrowserEvidence {
  const retained = observations.log.observations();
  const redacted_presentation = [...retained].reverse().find((observation) =>
    observation.type === "event" &&
    observation.name === "roleplaying.browser.presentation"
  );
  const redacted_game_text = redacted_presentation?.type === "event"
    ? redacted_presentation.evidence.game_text
    : undefined;
  if (typeof redacted_game_text !== "string") {
    throw new Error(
      `role-playing browser observation game text ${
        JSON.stringify(redacted_game_text)
      } must be text`,
    );
  }
  const redacted_debugger_message = [...observations.debugger_entries()]
    .reverse()
    .find(({ message }) => message.includes("roleplaying.browser.presentation"))
    ?.message.slice(0, 512);
  if (redacted_debugger_message === undefined) {
    throw new Error(
      "role-playing browser debugger omitted its presentation observation",
    );
  }
  const runtime: RoleplayingRevisionEvidence = revision === undefined
    ? { type: "initial" }
    : {
      type: "advanced",
      sequence: revision.sequence,
      snapshot_checksum: revision.snapshot_checksum,
    };
  return Object.freeze({
    version: 1,
    runtime: Object.freeze(runtime),
    presentation_source: serialize_roleplaying_presentation(presentation),
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
    audio_host: Object.freeze({
      accepted: Object.freeze(
        audio_host.accepted.map((command) => Object.freeze({ ...command })),
      ),
      command_capacity: audio_host.command_capacity,
      retained_commands: audio_host.retained_commands,
      state: audio_host.state,
    }),
  });
}

export function serialize_roleplaying_browser_evidence(
  evidence: RoleplayingBrowserEvidence,
): string {
  return JSON.stringify(evidence);
}

export function parse_roleplaying_browser_evidence(
  source: string,
): RoleplayingBrowserEvidence {
  const parsed: unknown = JSON.parse(source);
  const root = record(parsed, "role-playing browser evidence");
  if (root.version !== 1) {
    throw new Error(
      `role-playing browser evidence version ${
        JSON.stringify(root.version)
      } is unsupported`,
    );
  }
  const runtime = parse_revision(
    record(root.runtime, "role-playing browser runtime evidence"),
  );
  const renderer = record(
    root.renderer,
    "role-playing browser renderer evidence",
  );
  const status = one_of(
    renderer.status,
    ["ready", "path_tracing_unavailable", "device_error", "device_lost"],
    "role-playing renderer status",
  );
  const frame_type = one_of(
    renderer.frame_type,
    ["raster", "path_traced"],
    "role-playing renderer frame type",
  );
  const observations = record(
    root.observations,
    "role-playing browser observation evidence",
  );
  const observation_capacity = positive_integer(
    observations.capacity,
    "role-playing observation capacity",
  );
  const retained_observations = nonnegative_integer(
    observations.retained,
    "role-playing retained observations",
  );
  if (retained_observations > observation_capacity) {
    throw new Error(
      `role-playing retained observations ${retained_observations} exceed capacity ${observation_capacity}`,
    );
  }
  const audio_host = record(
    root.audio_host,
    "role-playing browser audio host evidence",
  );
  const command_capacity = positive_integer(
    audio_host.command_capacity,
    "role-playing audio command capacity",
  );
  const retained_commands = nonnegative_integer(
    audio_host.retained_commands,
    "role-playing retained audio commands",
  );
  if (retained_commands > command_capacity) {
    throw new Error(
      `role-playing retained audio commands ${retained_commands} exceed capacity ${command_capacity}`,
    );
  }
  const accepted_audio = array(
    audio_host.accepted,
    "role-playing accepted audio commands",
  ).map((entry, index) => {
    const command = record(
      entry,
      `role-playing accepted audio command[${index}]`,
    );
    return Object.freeze({
      cue: text(
        command.cue,
        `role-playing accepted audio command[${index}] cue`,
      ),
      sequence: nonnegative_integer(
        command.sequence,
        `role-playing accepted audio command[${index}] sequence`,
      ),
    });
  });
  if (accepted_audio.length > command_capacity) {
    throw new Error(
      `role-playing accepted audio commands ${accepted_audio.length} exceed capacity ${command_capacity}`,
    );
  }
  return Object.freeze({
    version: 1,
    runtime,
    presentation_source: text(
      root.presentation_source,
      "role-playing browser presentation source",
    ),
    renderer: Object.freeze({
      adapter_description: text(
        renderer.adapter_description,
        "role-playing renderer adapter",
      ),
      status,
      validation_error_count: nonnegative_integer(
        renderer.validation_error_count,
        "role-playing renderer validation errors",
      ),
      frame_type,
      center_pick: text(
        renderer.center_pick,
        "role-playing renderer center pick",
      ),
    }),
    observations: Object.freeze({
      capacity: observation_capacity,
      retained: retained_observations,
      dropped: nonnegative_integer(
        observations.dropped,
        "role-playing dropped observations",
      ),
      redacted_game_text: text(
        observations.redacted_game_text,
        "role-playing redacted game text",
      ),
      redacted_debugger_message: text(
        observations.redacted_debugger_message,
        "role-playing redacted debugger message",
      ),
    }),
    audio: Object.freeze(
      array(root.audio, "role-playing browser audio").map((entry, index) => {
        const effect = record(entry, `role-playing browser audio[${index}]`);
        return Object.freeze({
          id: text(effect.id, `role-playing browser audio[${index}] id`),
          cue: text(effect.cue, `role-playing browser audio[${index}] cue`),
        });
      }),
    ),
    audio_host: Object.freeze({
      accepted: Object.freeze(accepted_audio),
      command_capacity,
      retained_commands,
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
        "role-playing audio host state",
      ),
    }),
  });
}

function parse_revision(
  value: Readonly<Record<string, unknown>>,
): RoleplayingRevisionEvidence {
  if (value.type === "initial") return Object.freeze({ type: "initial" });
  if (value.type !== "advanced") {
    throw new Error(
      `role-playing browser runtime type ${
        JSON.stringify(value.type)
      } is unsupported`,
    );
  }
  const snapshot_checksum = text(
    value.snapshot_checksum,
    "role-playing snapshot checksum",
  );
  if (!/^[0-9a-f]{64}$/u.test(snapshot_checksum)) {
    throw new Error(
      `role-playing snapshot checksum ${
        JSON.stringify(snapshot_checksum)
      } must contain 64 lowercase hexadecimal characters`,
    );
  }
  return Object.freeze({
    type: "advanced",
    sequence: nonnegative_integer(value.sequence, "role-playing sequence"),
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

function one_of<const Value extends string>(
  value: unknown,
  supported: readonly Value[],
  label: string,
): Value {
  if (typeof value === "string") {
    const matched = supported.find((candidate) => candidate === value);
    if (matched !== undefined) return matched;
  }
  throw new Error(`${label} ${JSON.stringify(value)} is unsupported`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} ${JSON.stringify(value)} must be text`);
  }
  return value;
}

function positive_integer(value: unknown, label: string): number {
  const parsed = nonnegative_integer(value, label);
  if (parsed === 0) throw new Error(`${label} must be positive`);
  return parsed;
}

function nonnegative_integer(value: unknown, label: string): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < 0
  ) {
    throw new Error(
      `${label} ${JSON.stringify(value)} must be a nonnegative integer`,
    );
  }
  return value;
}
