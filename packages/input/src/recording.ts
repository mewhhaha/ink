import { frame_id, type FrameId } from "@ink/runtime/frame.ts";
import { type InputFrame, parse_input_frame } from "./model.ts";
import type { NormalizedDeviceEvent } from "./synthetic.ts";
import {
  parse_normalized_device_event,
  SyntheticInputAdapter,
} from "./synthetic.ts";

export interface RecordedDeviceFrame {
  readonly frame_id: FrameId;
  readonly events: readonly NormalizedDeviceEvent[];
}

export class RecordedInputAdapter {
  readonly #frames: readonly RecordedDeviceFrame[];
  readonly #source = new SyntheticInputAdapter();
  #next = 0;

  constructor(frames: readonly RecordedDeviceFrame[]) {
    let previous = -1;
    for (const [index, frame] of frames.entries()) {
      if (frame.frame_id <= previous) {
        throw new Error(
          `recorded input frame ${index} id ${frame.frame_id} must be greater than ${previous}`,
        );
      }
      previous = frame.frame_id;
    }
    this.#frames = Object.freeze(frames.map((frame) =>
      Object.freeze({
        frame_id: frame.frame_id,
        events: Object.freeze(frame.events.map(parse_normalized_device_event)),
      })
    ));
  }

  capture(expected_frame_id: FrameId) {
    const recorded = this.#frames[this.#next];
    if (recorded === undefined) {
      throw new Error(
        `recorded input has no frame ${expected_frame_id} at sequence ${this.#next}`,
      );
    }
    if (recorded.frame_id !== expected_frame_id) {
      throw new Error(
        `recorded input expected frame ${recorded.frame_id} at sequence ${this.#next}, received ${expected_frame_id}`,
      );
    }
    this.#next += 1;
    for (const event of recorded.events) this.#source.enqueue(event);
    return this.#source.capture(expected_frame_id);
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const empty_channel_snapshot = encoder.encode('{"version":1,"frame":null}');

export function encode_input_frame(frame: InputFrame): Uint8Array {
  return encoder.encode(JSON.stringify({ version: 1, frame }));
}

export function decode_input_frame(payload: Uint8Array): InputFrame {
  let source: string;
  try {
    source = decoder.decode(payload);
  } catch (error) {
    throw new Error("input frame recording is not valid UTF-8", {
      cause: error,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `input frame recording is malformed JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("input frame recording must contain version 1 and a frame");
  }
  const envelope = parsed as Record<string, unknown>;
  const fields = Object.keys(envelope).sort();
  if (
    fields.join("\n") !== "frame\nversion" || envelope.version !== 1 ||
    !("frame" in envelope)
  ) {
    throw new Error("input frame recording must contain version 1 and a frame");
  }
  return parse_input_frame(envelope.frame);
}

export class InputFrameChannel {
  readonly id = "input.frames";
  #current: InputFrame | null = null;

  update(frame: InputFrame): void {
    this.#current = frame;
  }

  current(): InputFrame | null {
    return this.#current;
  }

  snapshot(): Uint8Array {
    return this.#current === null
      ? empty_channel_snapshot.slice()
      : encode_input_frame(this.#current);
  }

  restore(payload: Uint8Array): void {
    if (
      payload.length === empty_channel_snapshot.length &&
      payload.every((byte, index) => byte === empty_channel_snapshot[index])
    ) {
      this.#current = null;
      return;
    }
    this.#current = decode_input_frame(payload);
  }
}

export function recorded_frame_id(value: number): FrameId {
  return frame_id(value);
}
