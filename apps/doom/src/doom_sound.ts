export interface DoomSound {
  readonly sample_rate: number;
  readonly samples: Uint8Array;
}

export function decode_doom_sound(bytes: Uint8Array): DoomSound {
  if (bytes.byteLength < 8) {
    throw new Error("Doom sound is shorter than its header");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const format = view.getUint16(0, true);
  const sample_rate = view.getUint16(2, true);
  const sample_count = view.getUint32(4, true);
  if (format !== 3) {
    throw new Error(`Unsupported Doom sound format: ${format}`);
  }
  if (sample_rate === 0) {
    throw new Error("Doom sound has a zero sample rate");
  }
  if (sample_count > bytes.byteLength - 8) {
    throw new Error("Doom sound sample data is truncated");
  }
  return {
    sample_rate,
    samples: bytes.slice(8, 8 + sample_count),
  };
}

export function encode_wav_pcm8(sound: DoomSound): Uint8Array {
  const data_size = sound.samples.length;
  const bytes = new Uint8Array(44 + data_size);
  const view = new DataView(bytes.buffer);
  write_ascii(bytes, 0, "RIFF");
  view.setUint32(4, 36 + data_size, true);
  write_ascii(bytes, 8, "WAVE");
  write_ascii(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sound.sample_rate, true);
  view.setUint32(28, sound.sample_rate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  write_ascii(bytes, 36, "data");
  view.setUint32(40, data_size, true);
  bytes.set(sound.samples, 44);
  return bytes;
}

function write_ascii(bytes: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    bytes[offset + index] = text.charCodeAt(index);
  }
}
