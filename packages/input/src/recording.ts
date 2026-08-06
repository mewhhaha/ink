import { frame_id, type FrameId } from "@ink/runtime/frame.ts";
import type { DeterministicChannel } from "@ink/runtime/determinism.ts";
import type { InputFrame } from "./model.ts";
import type { NormalizedDeviceEvent } from "./synthetic.ts";
import { SyntheticInputAdapter } from "./synthetic.ts";

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
        events: Object.freeze([...frame.events]),
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
const decoder = new TextDecoder();

export function encode_input_frame(frame: InputFrame): Uint8Array {
  return encoder.encode(JSON.stringify({ version: 1, frame }));
}

export function decode_input_frame(payload: Uint8Array): InputFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(payload));
  } catch (error) {
    throw new Error(
      `input frame recording is malformed JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    typeof parsed !== "object" || parsed === null || !("version" in parsed) ||
    parsed.version !== 1 || !("frame" in parsed)
  ) {
    throw new Error("input frame recording must contain version 1 and a frame");
  }
  if (typeof parsed.frame !== "object" || parsed.frame === null) {
    throw new Error("input frame recording frame must be an object");
  }
  const candidate = parsed.frame as Record<string, unknown>;
  if (
    !Number.isSafeInteger(candidate.frame_id) ||
    (candidate.frame_id as number) < 0 || !Array.isArray(candidate.actions)
  ) {
    throw new Error(
      `input frame recording has invalid frame id ${
        String(candidate.frame_id)
      } or actions`,
    );
  }
  if (
    typeof candidate.devices !== "object" || candidate.devices === null ||
    (candidate.devices as Record<string, unknown>).frame_id !==
      candidate.frame_id
  ) {
    throw new Error(
      `input frame ${candidate.frame_id} recording has missing or mismatched devices`,
    );
  }
  return Object.freeze({
    ...(candidate as unknown as InputFrame),
    frame_id: frame_id(candidate.frame_id as number),
  });
}

export class InputFrameChannel implements DeterministicChannel {
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
      ? encoder.encode('{"version":1,"frame":null}')
      : encode_input_frame(this.#current);
  }

  restore(payload: Uint8Array): void {
    const text = decoder.decode(payload);
    if (text === '{"version":1,"frame":null}') {
      this.#current = null;
      return;
    }
    this.#current = decode_input_frame(payload);
  }
}

export function recorded_frame_id(value: number): FrameId {
  return frame_id(value);
}
