export interface AudioStreamBufferSnapshot {
  readonly buffered_frames: number;
  readonly latency_seconds: number;
  readonly retained_bytes: number;
  readonly underruns: number;
  readonly last_sequence: number;
}

interface AudioChunk {
  readonly samples: Float32Array;
  offset_samples: number;
}

export class AudioStreamBuffer {
  readonly #channel_count: number;
  readonly #sample_rate: number;
  readonly #maximum_frames: number;
  readonly #chunks: AudioChunk[] = [];
  #buffered_frames = 0;
  #underruns = 0;
  #last_sequence = -1;

  constructor(
    channel_count: number,
    sample_rate: number,
    maximum_frames: number,
  ) {
    if (!Number.isSafeInteger(channel_count) || channel_count <= 0) {
      throw new Error(
        `audio stream channel count ${
          JSON.stringify(channel_count)
        } must be positive`,
      );
    }
    if (!Number.isFinite(sample_rate) || sample_rate <= 0) {
      throw new Error(
        `audio stream sample rate ${
          JSON.stringify(sample_rate)
        } must be positive`,
      );
    }
    if (!Number.isSafeInteger(maximum_frames) || maximum_frames <= 0) {
      throw new Error(
        `audio stream maximum frames ${
          JSON.stringify(maximum_frames)
        } must be positive`,
      );
    }
    this.#channel_count = channel_count;
    this.#sample_rate = sample_rate;
    this.#maximum_frames = maximum_frames;
  }

  append(
    sequence: number,
    interleaved_samples: Float32Array,
  ): AudioStreamBufferSnapshot {
    if (!Number.isSafeInteger(sequence) || sequence <= this.#last_sequence) {
      throw new Error(
        `audio stream chunk sequence ${
          JSON.stringify(sequence)
        } must exceed ${this.#last_sequence}`,
      );
    }
    if (
      interleaved_samples.length === 0 ||
      interleaved_samples.length % this.#channel_count !== 0
    ) {
      throw new Error(
        `audio stream chunk ${sequence} sample count ${interleaved_samples.length} must be a positive multiple of ${this.#channel_count}`,
      );
    }
    const samples = new Float32Array(interleaved_samples);
    this.#chunks.push({ samples, offset_samples: 0 });
    this.#buffered_frames += samples.length / this.#channel_count;
    this.#last_sequence = sequence;
    this.#discard_overflow();
    return this.snapshot();
  }

  consume(frame_count: number): Float32Array {
    if (!Number.isSafeInteger(frame_count) || frame_count <= 0) {
      throw new Error(
        `audio stream consume frame count ${
          JSON.stringify(frame_count)
        } must be positive`,
      );
    }
    const output = new Float32Array(frame_count * this.#channel_count);
    const available_frames = Math.min(frame_count, this.#buffered_frames);
    let remaining_samples = available_frames * this.#channel_count;
    let output_offset = 0;
    while (remaining_samples > 0) {
      const chunk = this.#chunks[0];
      const available_samples = chunk.samples.length - chunk.offset_samples;
      const copy_count = Math.min(available_samples, remaining_samples);
      output.set(
        chunk.samples.subarray(
          chunk.offset_samples,
          chunk.offset_samples + copy_count,
        ),
        output_offset,
      );
      chunk.offset_samples += copy_count;
      output_offset += copy_count;
      remaining_samples -= copy_count;
      if (chunk.offset_samples === chunk.samples.length) this.#chunks.shift();
    }
    this.#buffered_frames -= available_frames;
    if (available_frames < frame_count) this.#underruns += 1;
    return output;
  }

  snapshot(): AudioStreamBufferSnapshot {
    return {
      buffered_frames: this.#buffered_frames,
      latency_seconds: this.#buffered_frames / this.#sample_rate,
      retained_bytes: this.#buffered_frames * this.#channel_count *
        Float32Array.BYTES_PER_ELEMENT,
      underruns: this.#underruns,
      last_sequence: this.#last_sequence,
    };
  }

  #discard_overflow(): void {
    let frames_to_discard = this.#buffered_frames - this.#maximum_frames;
    while (frames_to_discard > 0) {
      const chunk = this.#chunks[0];
      const available_frames = (chunk.samples.length - chunk.offset_samples) /
        this.#channel_count;
      const discarded_frames = Math.min(frames_to_discard, available_frames);
      chunk.offset_samples += discarded_frames * this.#channel_count;
      this.#buffered_frames -= discarded_frames;
      frames_to_discard -= discarded_frames;
      if (chunk.offset_samples === chunk.samples.length) this.#chunks.shift();
    }
  }
}
