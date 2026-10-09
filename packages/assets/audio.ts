/**
 * Sound import: turns a project's .wav/.ogg/.mp3/.flac into a compact file that
 * the player can fetch and hand to `AudioContext.decodeAudioData`.
 *
 * Output is Ogg Opus. Chromium and Firefox decode it through
 * `decodeAudioData` (checked with this encoder); Safari's Ogg Opus support is
 * newer and was not tested.
 *
 * How it is done, and why
 * -----------------------
 * - WAV is decoded in plain TypeScript (PCM 8/16/24/32-bit, float 32/64,
 *   WAVE_FORMAT_EXTENSIBLE, odd chunk padding, truncated or streamed `data`
 *   chunks), downmixed to stereo when it has more channels, resampled to 48 kHz
 *   with a windowed-sinc polyphase filter, and encoded in 20 ms frames.
 * - The Opus encoder is `opusscript` (npm, MIT): libopus 1.4 compiled by
 *   emscripten to a single 310 KB wasm file. It needs no native toolchain and
 *   no prebuilt `.node` binary, loads from Deno through the npm compatibility
 *   layer (`nodeModulesDir: "auto"`) and works inside a Deno worker. libopus
 *   itself is BSD-3-Clause (its notice ships in the package). The alternative
 *   `@evan/opus` was passed over: it prefers an architecture-specific native
 *   addon and carries two wasm builds (plain and SIMD) whose float results may
 *   differ, which would make output depend on the machine. Here every machine
 *   runs the same wasm, so the same input gives the same bytes. The binding
 *   takes 16-bit samples only, which is all a lossy codec at these bitrates
 *   can use.
 * - The Ogg Opus stream (RFC 7845) is written here: OpusHead and OpusTags pages,
 *   audio pages with lacing, CRC-32 (polynomial 0x04c11db7), granule positions
 *   that account for the encoder's 312-sample look-ahead (the pre-skip) and
 *   trim the final frame, increasing page sequence numbers and the EOS flag.
 *   The stream serial is taken from the SHA-256 of the input, so output is
 *   byte-identical for identical input and options.
 * - Ogg and MP3 (and FLAC) cannot be decoded in pure form here. When an
 *   `ffmpeg` executable is found it is used as a *decoder only*: it converts
 *   the file to 32-bit float WAV at the source rate and channel count, and the
 *   result goes through the very same resample/encode/mux path as a WAV. The
 *   encoder is therefore never ffmpeg's, so output does not depend on the
 *   ffmpeg build (its Ogg muxer would stamp a random serial and an encoder
 *   string). Lossy sources are only replaced when the Opus file is smaller.
 *   Ogg Opus input is shipped unchanged. Without ffmpeg (or when it fails)
 *   other files pass through unchanged after their headers are validated.
 * - If the wasm encoder cannot be loaded at all, a WAV is normalised to 16-bit
 *   PCM instead (codec "wav-pcm16": more than two channels downmixed to stereo,
 *   every non-audio chunk dropped, nothing trimmed or resampled).
 *
 * Known gaps: loop points and other RIFF metadata are dropped; more than two
 * channels become stereo; A-law/mu-law/ADPCM WAV and RF64 are rejected; without
 * ffmpeg an MP3 or Ogg Vorbis file is shipped as it is.
 *
 * Self-contained so it can run in a worker; the only Deno APIs are
 * `Deno.Command` and `Deno.makeTempDir` in the optional ffmpeg path.
 */
import { sha256 } from "./hash.ts";

export interface AudioResult {
  /** The file to serve/ship. */
  bytes: Uint8Array;
  ext: string;
  mime: string;
  codec: "opus" | "wav-pcm16" | "passthrough";
  info: {
    sampleRate: number;
    channels: number;
    seconds: number;
    sourceBytes: number;
    outputBytes: number;
  };
  /** Set when the result is not what was asked for, and why. */
  note?: string;
}

export interface AudioOptions {
  /** Opus bits per second for the whole stream: 96000 for stereo, 64000 for
   * mono by default. */
  bitrate?: number;
}

/** Planar float samples, nominally in -1..1. */
export interface Pcm {
  sampleRate: number;
  channels: Float32Array[];
  /** Speaker positions as a WAVE channel mask; 0 when unknown. */
  mask: number;
}

type Container = "wav" | "ogg" | "mp3" | "flac";

const OPUS_RATE = 48000;
/** 20 ms at 48 kHz. */
const FRAME = 960;
/** libopus look-ahead in AUDIO mode at 48 kHz: Fs/400 + Fs/250. */
const PRE_SKIP = 312;
const VENDOR = "ink assets, libopus 1.4";

const DEFAULT_BITRATE = { 1: 64000, 2: 96000 } as const;
const MIN_BITRATE = 6000;
const MAX_BITRATE_PER_CHANNEL = 256000;

const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000;

const MIME: Record<Container, string> = {
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
  flac: "audio/flac",
};

/** Encode, copy or normalise one sound file. */
export async function transcodeAudio(
  bytes: Uint8Array,
  path: string,
  options: AudioOptions = {},
): Promise<AudioResult> {
  const bitrate = checkBitrate(options.bitrate, path);
  const kind = sniff(bytes, path);
  if (kind === "wav") {
    return await encodePcm(decodeWav(bytes, path), bytes, bitrate);
  }

  // Describing the original validates its header. A file only ffmpeg
  // understands (Ogg FLAC, say) may still be worth converting.
  let source: AudioResult | Error;
  try {
    source = probeAudio(bytes, path);
  } catch (error) {
    source = error as Error;
  }
  if (!(kind === "ogg" && oggCodec(bytes) === "opus")) {
    const wav = await ffmpegDecode(bytes, kind);
    if (wav) {
      try {
        const opus = await encodePcm(decodeWav(wav, path), bytes, bitrate);
        if (opus.codec === "opus" && opus.bytes.length < bytes.length) {
          return opus;
        }
      } catch {
        // ffmpeg produced something unusable: ship the original.
      }
    }
  }
  if (source instanceof Error) throw source;
  return source;
}

/**
 * Validate an audio file's header and describe it without re-encoding: the
 * result is the file itself ("passthrough"). Throws for anything that is not a
 * recognisable WAV, Ogg (Opus or Vorbis), MP3 or FLAC.
 */
export function probeAudio(bytes: Uint8Array, path: string): AudioResult {
  const kind = sniff(bytes, path);
  const info = kind === "wav"
    ? probeWav(bytes, path)
    : kind === "ogg"
    ? probeOgg(bytes, path)
    : kind === "mp3"
    ? probeMp3(bytes, path)
    : probeFlac(bytes, path);
  return {
    bytes,
    ext: kind,
    mime: MIME[kind],
    codec: "passthrough",
    info: { ...info, sourceBytes: bytes.length, outputBytes: bytes.length },
  };
}

function checkBitrate(
  bitrate: number | undefined,
  path: string,
): number | undefined {
  if (bitrate === undefined) return undefined;
  if (!Number.isFinite(bitrate) || bitrate < MIN_BITRATE) {
    throw new RangeError(
      `${path}: bitrate must be at least ${MIN_BITRATE} bits/s, got ${bitrate}`,
    );
  }
  return Math.round(bitrate);
}

// ---------------------------------------------------------------------------
// Format sniffing

const ascii = (bytes: Uint8Array, at: number, length: number) =>
  String.fromCharCode(...bytes.subarray(at, at + length));

function sniff(bytes: Uint8Array, path: string): Container {
  if (bytes.length < 4) throw new Error(`${path}: empty or truncated file`);
  const head = ascii(bytes, 0, 4);
  if (head === "RF64" || head === "BW64") {
    throw new Error(`${path}: RF64 WAV files are not supported`);
  }
  if (head === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return "wav";
  if (head === "OggS" && bytes[4] === 0 && ((bytes[5] ?? 0) & 0x02) !== 0) {
    return "ogg";
  }
  if (head === "fLaC") return "flac";
  if (head.startsWith("ID3") || mp3Header(bytes, 0)) return "mp3";
  throw new Error(
    `${path}: not a WAV, Ogg, MP3 or FLAC file (starts with ${
      [...bytes.subarray(0, 4)].map((b) => b.toString(16).padStart(2, "0"))
        .join(" ")
    })`,
  );
}

// ---------------------------------------------------------------------------
// WAV

interface WavLayout {
  sampleRate: number;
  channels: number;
  mask: number;
  float: boolean;
  /** Bytes per sample in the file. */
  width: number;
  start: number;
  end: number;
}

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

function isChunkId(bytes: Uint8Array, at: number): boolean {
  if (at + 4 > bytes.length) return false;
  for (let i = 0; i < 4; i++) {
    const b = bytes[at + i];
    if (b < 0x20 || b > 0x7e) return false;
  }
  return true;
}

/** Locate the format and the sample bytes of a WAV file. */
function parseWav(bytes: Uint8Array, path: string): WavLayout {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riffSize = view.getUint32(4, true);
  const streamed = riffSize === 0 || riffSize === 0xffffffff;
  let fmt: Omit<WavLayout, "start" | "end"> | undefined;
  let data: { start: number; end: number } | undefined;

  let at = 12;
  while (at + 8 <= bytes.length && !(fmt && data)) {
    const id = ascii(bytes, at, 4);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt " && !fmt) {
      if (size < 16 || body + 16 > bytes.length) {
        throw new Error(`${path}: truncated WAV fmt chunk`);
      }
      let tag = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const blockAlign = view.getUint16(body + 12, true);
      const bits = view.getUint16(body + 14, true);
      let mask = 0;
      if (tag === WAVE_FORMAT_EXTENSIBLE) {
        if (size < 40 || body + 40 > bytes.length) {
          throw new Error(`${path}: truncated WAVE_FORMAT_EXTENSIBLE chunk`);
        }
        mask = view.getUint32(body + 20, true);
        tag = view.getUint16(body + 24, true);
      }
      if (tag !== WAVE_FORMAT_PCM && tag !== WAVE_FORMAT_FLOAT) {
        throw new Error(
          `${path}: unsupported WAV format 0x${
            tag.toString(16)
          } (only PCM and IEEE float)`,
        );
      }
      if (channels < 1 || channels > 32) {
        throw new Error(`${path}: unsupported WAV channel count ${channels}`);
      }
      if (sampleRate < 1 || sampleRate > 1_536_000) {
        throw new Error(`${path}: unsupported WAV sample rate ${sampleRate}`);
      }
      // The container may be wider than the valid bits (24 in 32); trust the
      // block alignment when it is consistent.
      let width = Math.ceil(bits / 8);
      if (blockAlign % channels === 0 && blockAlign / channels !== width) {
        const w = blockAlign / channels;
        if (w >= 1 && w <= 8) width = w;
      }
      const float = tag === WAVE_FORMAT_FLOAT;
      if (float ? width !== 4 && width !== 8 : width < 1 || width > 4) {
        throw new Error(
          `${path}: unsupported WAV sample size (${bits} bits, ${
            float ? "float" : "PCM"
          })`,
        );
      }
      if (!mask || popcount(mask) !== channels) mask = defaultMask(channels);
      fmt = { sampleRate, channels, mask, float, width };
    } else if (id === "data" && !data) {
      let end = body + size;
      if (size === 0xffffffff || end > bytes.length) end = bytes.length;
      else if (size === 0 && streamed) end = bytes.length;
      data = { start: body, end };
    }
    let next = body + size;
    // Chunks are padded to even size, though not every writer does it.
    if ((size & 1) && (isChunkId(bytes, next + 1) || !isChunkId(bytes, next))) {
      next += 1;
    }
    if (next <= at) break;
    at = next;
  }

  if (!fmt) throw new Error(`${path}: WAV file has no fmt chunk`);
  if (!data) throw new Error(`${path}: WAV file has no data chunk`);
  return { ...fmt, ...data };
}

function probeWav(bytes: Uint8Array, path: string) {
  const wav = parseWav(bytes, path);
  const frames = Math.floor((wav.end - wav.start) / (wav.channels * wav.width));
  return {
    sampleRate: wav.sampleRate,
    channels: wav.channels,
    seconds: frames / wav.sampleRate,
  };
}

/** Decode a WAV file to planar float samples. */
export function decodeWav(bytes: Uint8Array, path = "audio.wav"): Pcm {
  if (bytes.length < 12 || ascii(bytes, 0, 4) !== "RIFF") {
    throw new Error(`${path}: not a RIFF/WAVE file`);
  }
  const wav = parseWav(bytes, path);
  const stride = wav.channels * wav.width;
  // A cut-off file keeps its whole frames.
  const frames = Math.floor((wav.end - wav.start) / stride);
  if (frames === 0) throw new Error(`${path}: WAV file has no audio samples`);

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const channels: Float32Array[] = [];
  for (let c = 0; c < wav.channels; c++) {
    const out = new Float32Array(frames);
    let at = wav.start + c * wav.width;
    if (wav.float && wav.width === 4) {
      for (let i = 0; i < frames; i++, at += stride) {
        const x = view.getFloat32(at, true);
        out[i] = x - x === 0 ? x : 0;
      }
    } else if (wav.float) {
      for (let i = 0; i < frames; i++, at += stride) {
        const x = view.getFloat64(at, true);
        out[i] = x - x === 0 ? x : 0;
      }
    } else if (wav.width === 1) {
      for (let i = 0; i < frames; i++, at += stride) {
        out[i] = (bytes[at] - 128) / 128;
      }
    } else if (wav.width === 2) {
      for (let i = 0; i < frames; i++, at += stride) {
        out[i] = view.getInt16(at, true) / 32768;
      }
    } else if (wav.width === 3) {
      for (let i = 0; i < frames; i++, at += stride) {
        const v = bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
        out[i] = ((v << 8) >> 8) / 8388608;
      }
    } else {
      for (let i = 0; i < frames; i++, at += stride) {
        out[i] = view.getInt32(at, true) / 2147483648;
      }
    }
    channels.push(out);
  }
  return { sampleRate: wav.sampleRate, channels, mask: wav.mask };
}

function popcount(mask: number): number {
  let n = 0;
  for (let m = mask >>> 0; m; m &= m - 1) n++;
  return n;
}

/** Speaker layout assumed when a file does not say. */
function defaultMask(channels: number): number {
  const FL = 0x1, FR = 0x2, FC = 0x4, LFE = 0x8, BL = 0x10, BR = 0x20;
  const BC = 0x100, SL = 0x200, SR = 0x400;
  switch (channels) {
    case 1:
      return FC;
    case 2:
      return FL | FR;
    case 3:
      return FL | FR | FC;
    case 4:
      return FL | FR | BL | BR;
    case 5:
      return FL | FR | FC | BL | BR;
    case 6:
      return FL | FR | FC | LFE | BL | BR;
    case 7:
      return FL | FR | FC | LFE | BC | SL | SR;
    case 8:
      return FL | FR | FC | LFE | BL | BR | SL | SR;
    default:
      return FL | FR; // the rest is dropped
  }
}

/** Contribution of each WAVE speaker position (by mask bit) to [left, right]. */
const H = Math.SQRT1_2;
const DOWNMIX: [number, number][] = [
  [1, 0], // front left
  [0, 1], // front right
  [H, H], // front centre
  [0, 0], // LFE: dropped, like most players
  [H, 0], // back left
  [0, H], // back right
  [0.5, 0], // front left of centre
  [0, 0.5], // front right of centre
  [0.5, 0.5], // back centre
  [H, 0], // side left
  [0, H], // side right
  [0.5, 0.5], // top centre
  [0.5, 0], // top front left
  [0.35, 0.35], // top front centre
  [0, 0.5], // top front right
  [0.5, 0], // top back left
  [0.35, 0.35], // top back centre
  [0, 0.5], // top back right
];

/** Fold any layout down to two channels, normalised so it cannot clip. */
function toStereo(pcm: Pcm): Float32Array[] {
  if (pcm.channels.length <= 2) return pcm.channels;
  const gains: [number, number][] = [];
  for (let bit = 0; bit < 32 && gains.length < pcm.channels.length; bit++) {
    if (!(pcm.mask >>> bit & 1)) continue;
    gains.push(DOWNMIX[bit] ?? [0, 0]);
  }
  while (gains.length < pcm.channels.length) gains.push([0, 0]);
  const sumL = gains.reduce((s, g) => s + g[0], 0);
  const sumR = gains.reduce((s, g) => s + g[1], 0);
  const norm = 1 / Math.max(1, sumL, sumR);
  const frames = pcm.channels[0].length;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let c = 0; c < gains.length; c++) {
    const [gl, gr] = gains[c];
    if (gl === 0 && gr === 0) continue;
    const src = pcm.channels[c];
    for (let i = 0; i < frames; i++) {
      left[i] += src[i] * gl * norm;
      right[i] += src[i] * gr * norm;
    }
  }
  return [left, right];
}

const toInt16 = (x: number) =>
  Math.max(-32768, Math.min(32767, Math.round(x * 32768)));

/**
 * WAV rewritten as 16-bit PCM with at most two channels: the fallback when no
 * Opus encoder is available. Sample rate and length are untouched.
 */
export function normalizeWav(bytes: Uint8Array, path = "audio.wav") {
  return writeWav16(decodeWav(bytes, path));
}

function writeWav16(pcm: Pcm) {
  const channels = toStereo(pcm);
  const nch = channels.length;
  const frames = channels[0].length;
  const out = new Uint8Array(44 + frames * nch * 2);
  const view = new DataView(out.buffer);
  const put = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i);
  };
  put(0, "RIFF");
  view.setUint32(4, out.length - 8, true);
  put(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, WAVE_FORMAT_PCM, true);
  view.setUint16(22, nch, true);
  view.setUint32(24, pcm.sampleRate, true);
  view.setUint32(28, pcm.sampleRate * nch * 2, true);
  view.setUint16(32, nch * 2, true);
  view.setUint16(34, 16, true);
  put(36, "data");
  view.setUint32(40, frames * nch * 2, true);
  let at = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++, at += 2) {
      view.setInt16(at, toInt16(channels[c][i]), true);
    }
  }
  return { bytes: out, sampleRate: pcm.sampleRate, channels: nch, frames };
}

// ---------------------------------------------------------------------------
// Resampling

const MAX_PHASES = 4096;
const ZERO_CROSSINGS = 24;
const KAISER_BETA = 9;
/** Low-pass edge as a fraction of the lower of the two Nyquist frequencies. */
const PASSBAND = 0.95;

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** Modified Bessel function of the first kind, order zero. */
function bessel0(x: number): number {
  let sum = 1;
  let term = 1;
  const q = x * x / 4;
  for (let k = 1; k < 64; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-16) break;
  }
  return sum;
}

/**
 * Windowed-sinc (Kaiser) polyphase resampler. For rational ratios of up to
 * 4096 phases (44.1 kHz to 48 kHz needs 160) the filter is exact; otherwise the
 * fractional position is rounded to 1/4096 of a source sample. Samples outside
 * the input count as silence, and the output keeps the input's duration.
 */
export function resample(
  input: Float32Array,
  from: number,
  to: number,
): Float32Array {
  if (from === to) return input;
  const outLength = Math.max(1, Math.round(input.length * to / from));
  const g = gcd(from, to);
  const exact = to / g <= MAX_PHASES;
  const phases = exact ? to / g : MAX_PHASES;
  const cutoff = PASSBAND * Math.min(1, to / from);
  const reach = ZERO_CROSSINGS / cutoff;
  const half = Math.ceil(reach);
  const taps = 2 * half;
  const norm = bessel0(KAISER_BETA);

  const table = new Float32Array(phases * taps);
  const row = new Float64Array(taps);
  for (let p = 0; p < phases; p++) {
    let sum = 0;
    for (let k = 0; k < taps; k++) {
      // Distance of source sample (i0 - half + 1 + k) from the position
      // i0 + p / phases.
      const x = k - half + 1 - p / phases;
      const r = x / reach;
      const window = Math.abs(r) >= 1
        ? 0
        : bessel0(KAISER_BETA * Math.sqrt(1 - r * r)) / norm;
      const a = Math.PI * cutoff * x;
      row[k] = (a === 0 ? 1 : Math.sin(a) / a) * window;
      sum += row[k];
    }
    for (let k = 0; k < taps; k++) table[p * taps + k] = row[k] / sum;
  }

  const n = input.length;
  const out = new Float32Array(outLength);
  for (let j = 0; j < outLength; j++) {
    const position = j * from;
    const rest = position % to;
    let i0 = (position - rest) / to;
    let p = exact ? rest / g : Math.round(rest * phases / to);
    if (p >= phases) {
      p -= phases;
      i0++;
    }
    const first = i0 - half + 1;
    const base = p * taps;
    let acc = 0;
    if (first >= 0 && first + taps <= n) {
      for (let k = 0; k < taps; k++) acc += table[base + k] * input[first + k];
    } else {
      for (let k = 0; k < taps; k++) {
        const i = first + k;
        if (i >= 0 && i < n) acc += table[base + k] * input[i];
      }
    }
    out[j] = acc;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Opus

interface OpusEncoder {
  /** `pcm` holds little-endian 16-bit samples as bytes, interleaved. */
  encode(pcm: Uint8Array, frameSize: number): Uint8Array;
  encoderCTL(ctl: number, arg: number): void;
  setBitrate(bitrate: number): void;
  delete(): void;
}
interface OpusConstructor {
  new (
    sampleRate: number,
    channels: number,
    application: number,
  ): OpusEncoder;
  Application: { AUDIO: number };
}

const OPUS_SET_VBR = 4006;
const OPUS_SET_VBR_CONSTRAINT = 4020;
const OPUS_SET_COMPLEXITY = 4010;
const OPUS_SET_LSB_DEPTH = 4036;

let opusModule: Promise<OpusConstructor | Error> | undefined;

/** The wasm encoder, or why it cannot be loaded in this runtime. */
function loadOpus(): Promise<OpusConstructor | Error> {
  opusModule ??= import("opusscript").then(
    (module) => (module.default ?? module) as unknown as OpusConstructor,
    (error) => error instanceof Error ? error : new Error(String(error)),
  );
  return opusModule;
}

async function encodePcm(
  pcm: Pcm,
  source: Uint8Array,
  bitrate: number | undefined,
): Promise<AudioResult> {
  const Opus = await loadOpus();
  if (Opus instanceof Error) return wavFallback(source, pcm, Opus);

  const folded = toStereo(pcm);
  const channels = folded.map((c) => resample(c, pcm.sampleRate, OPUS_RATE));
  const total = channels[0].length;
  const rate = bitrate ?? DEFAULT_BITRATE[channels.length as 1 | 2];
  const serial = parseInt((await sha256(source)).slice(0, 8), 16);

  const packets = encodeFrames(Opus, channels, rate);
  const ogg = muxOpus(packets, {
    serial,
    channels: channels.length,
    inputRate: pcm.sampleRate,
    total,
  });
  return {
    bytes: ogg,
    ext: "ogg",
    mime: MIME.ogg,
    codec: "opus",
    info: {
      sampleRate: OPUS_RATE,
      channels: channels.length,
      seconds: total / OPUS_RATE,
      sourceBytes: source.length,
      outputBytes: ogg.length,
    },
  };
}

function wavFallback(source: Uint8Array, pcm: Pcm, why: Error): AudioResult {
  const wav = writeWav16(pcm);
  return {
    note: `Opus encoder unavailable (${why.message}); kept 16-bit PCM`,
    bytes: wav.bytes,
    ext: "wav",
    mime: MIME.wav,
    codec: "wav-pcm16",
    info: {
      sampleRate: wav.sampleRate,
      channels: wav.channels,
      seconds: wav.frames / wav.sampleRate,
      sourceBytes: source.length,
      outputBytes: wav.bytes.length,
    },
  };
}

/** Encode 48 kHz planar samples into 20 ms Opus packets. The tail is padded
 * with silence so the stream covers `PRE_SKIP + length` samples. */
function encodeFrames(
  Opus: OpusConstructor,
  channels: Float32Array[],
  bitrate: number,
): Uint8Array[] {
  const nch = channels.length;
  const length = channels[0].length;
  const frames = Math.ceil((length + PRE_SKIP) / FRAME);
  const encoder = new Opus(OPUS_RATE, nch, Opus.Application.AUDIO);
  const packets: Uint8Array[] = [];
  try {
    encoder.setBitrate(Math.min(bitrate, MAX_BITRATE_PER_CHANNEL * nch));
    encoder.encoderCTL(OPUS_SET_COMPLEXITY, 10);
    // Constrained VBR keeps the average at the requested bitrate; the
    // unconstrained mode overshoots it by up to 60% on tonal sounds.
    encoder.encoderCTL(OPUS_SET_VBR, 1);
    encoder.encoderCTL(OPUS_SET_VBR_CONSTRAINT, 1);
    encoder.encoderCTL(OPUS_SET_LSB_DEPTH, 16);
    const pcm = new Uint8Array(FRAME * nch * 2);
    const view = new DataView(pcm.buffer);
    for (let f = 0; f < frames; f++) {
      const base = f * FRAME;
      for (let c = 0; c < nch; c++) {
        const src = channels[c];
        for (let i = 0; i < FRAME; i++) {
          const at = base + i;
          const sample = at < length ? toInt16(src[at]) : 0;
          view.setInt16((i * nch + c) * 2, sample, true);
        }
      }
      packets.push(new Uint8Array(encoder.encode(pcm, FRAME)));
    }
  } finally {
    encoder.delete();
  }
  return packets;
}

// ---------------------------------------------------------------------------
// Ogg

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) {
      r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    }
    table[i] = r >>> 0;
  }
  return table;
})();

function oggCrc(page: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < page.length; i++) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ page[i]) & 0xff]) >>> 0;
  }
  return crc;
}

const OGG_BEGIN = 0x02;
const OGG_END = 0x04;

function oggPage(
  serial: number,
  sequence: number,
  flags: number,
  granule: number,
  packets: Uint8Array[],
): Uint8Array {
  const lacing: number[] = [];
  let payload = 0;
  for (const packet of packets) {
    let rest = packet.length;
    for (; rest >= 255; rest -= 255) lacing.push(255);
    lacing.push(rest);
    payload += packet.length;
  }
  if (lacing.length > 255) {
    throw new Error("Ogg page needs more than 255 segments");
  }
  const page = new Uint8Array(27 + lacing.length + payload);
  const view = new DataView(page.buffer);
  page.set([0x4f, 0x67, 0x67, 0x53, 0, flags], 0); // "OggS", version 0
  view.setUint32(6, granule % 0x100000000, true);
  view.setUint32(10, Math.floor(granule / 0x100000000), true);
  view.setUint32(14, serial, true);
  view.setUint32(18, sequence, true);
  page[26] = lacing.length;
  page.set(lacing, 27);
  let at = 27 + lacing.length;
  for (const packet of packets) {
    page.set(packet, at);
    at += packet.length;
  }
  view.setUint32(22, oggCrc(page), true);
  return page;
}

/** Longest stretch of audio in one page, in packets (one second). */
const PAGE_PACKETS = 50;

function muxOpus(
  packets: Uint8Array[],
  stream: {
    serial: number;
    channels: number;
    inputRate: number;
    total: number;
  },
): Uint8Array {
  const text = new TextEncoder();

  const head = new Uint8Array(19);
  const headView = new DataView(head.buffer);
  head.set(text.encode("OpusHead"), 0);
  head[8] = 1; // version
  head[9] = stream.channels;
  headView.setUint16(10, PRE_SKIP, true);
  headView.setUint32(12, stream.inputRate, true);
  headView.setInt16(16, 0, true); // output gain
  head[18] = 0; // channel mapping family 0: mono or stereo

  const vendor = text.encode(VENDOR);
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  const tagsView = new DataView(tags.buffer);
  tags.set(text.encode("OpusTags"), 0);
  tagsView.setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  tagsView.setUint32(12 + vendor.length, 0, true); // no user comments

  const pages: Uint8Array[] = [
    oggPage(stream.serial, 0, OGG_BEGIN, 0, [head]),
    oggPage(stream.serial, 1, 0, 0, [tags]),
  ];

  // The last granule position is the number of samples the decoder should
  // have produced, pre-skip included; it trims the padding of the last frame.
  const end = PRE_SKIP + stream.total;
  let batch: Uint8Array[] = [];
  let segments = 0;
  let firstOfBatch = 0;
  const flush = (last: number, final: boolean) => {
    const granule = Math.min((last + 1) * FRAME, end);
    pages.push(
      oggPage(
        stream.serial,
        pages.length,
        final ? OGG_END : 0,
        granule,
        batch,
      ),
    );
    batch = [];
    segments = 0;
    firstOfBatch = last + 1;
  };
  for (let i = 0; i < packets.length; i++) {
    const needed = Math.floor(packets[i].length / 255) + 1;
    if (
      batch.length && (segments + needed > 255 || batch.length >= PAGE_PACKETS)
    ) {
      flush(firstOfBatch + batch.length - 1, false);
    }
    batch.push(packets[i]);
    segments += needed;
  }
  flush(firstOfBatch + batch.length - 1, true);

  const out = new Uint8Array(pages.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const page of pages) {
    out.set(page, at);
    at += page.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Header probes for files that are shipped as they are

type OggCodec = "opus" | "vorbis" | "flac" | "speex" | "other";

interface OggScan {
  /** First packet of the stream: the identification header. */
  first: Uint8Array;
  /** Granule position of the last page that has one, or -1. */
  granule: number;
}

function scanOgg(bytes: Uint8Array, path: string): OggScan {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let first: Uint8Array | undefined;
  let granule = -1;
  let at = 0;
  while (at + 27 <= bytes.length && ascii(bytes, at, 4) === "OggS") {
    const segments = bytes[at + 26];
    const bodyAt = at + 27 + segments;
    if (bodyAt > bytes.length) break;
    let size = 0;
    for (let i = 0; i < segments; i++) size += bytes[at + 27 + i];
    if (!first) {
      first = bytes.subarray(bodyAt, Math.min(bodyAt + size, bytes.length));
    }
    const low = view.getUint32(at + 6, true);
    const high = view.getUint32(at + 10, true);
    if (!(low === 0xffffffff && high === 0xffffffff)) {
      granule = high * 0x100000000 + low;
    }
    at = bodyAt + size;
  }
  if (!first) throw new Error(`${path}: Ogg file has no pages`);
  return { first, granule };
}

function oggCodec(bytes: Uint8Array): OggCodec {
  let scan: OggScan;
  try {
    scan = scanOgg(bytes, "");
  } catch {
    return "other";
  }
  const id = scan.first;
  if (ascii(id, 0, 8) === "OpusHead") return "opus";
  if (id[0] === 0x01 && ascii(id, 1, 6) === "vorbis") return "vorbis";
  if (id[0] === 0x7f && ascii(id, 1, 4) === "FLAC") return "flac";
  if (ascii(id, 0, 8) === "Speex   ") return "speex";
  return "other";
}

function probeOgg(bytes: Uint8Array, path: string) {
  const { first, granule } = scanOgg(bytes, path);
  const view = new DataView(first.buffer, first.byteOffset, first.byteLength);
  const codec = oggCodec(bytes);
  if (codec === "opus" && first.length >= 19) {
    const preSkip = view.getUint16(10, true);
    return {
      sampleRate: OPUS_RATE,
      channels: first[9],
      seconds: Math.max(0, granule - preSkip) / OPUS_RATE,
    };
  }
  if (codec === "vorbis" && first.length >= 16) {
    const sampleRate = view.getUint32(12, true);
    return {
      sampleRate,
      channels: first[11],
      seconds: sampleRate > 0 ? Math.max(0, granule) / sampleRate : 0,
    };
  }
  throw new Error(
    `${path}: unsupported Ogg stream (${codec}); only Opus and Vorbis are`,
  );
}

const MP3_BITRATES = {
  // [version 1, version 2/2.5] by layer, in kbit/s; index 0 is "free format"
  1: [
    [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  ],
  2: [
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  ],
  3: [
    [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  ],
} as const;
const MP3_RATES = [[11025, 12000, 8000], [], [22050, 24000, 16000], [
  44100,
  48000,
  32000,
]];

interface Mp3Frame {
  size: number;
  samples: number;
  sampleRate: number;
  channels: number;
}

/** The MPEG audio frame header at `at`, or null when there is none. */
function mp3Header(bytes: Uint8Array, at: number): Mp3Frame | null {
  if (at + 4 > bytes.length) return null;
  if (bytes[at] !== 0xff) return null;
  const b1 = bytes[at + 1];
  const b2 = bytes[at + 2];
  const b3 = bytes[at + 3];
  if ((b1 & 0xe0) !== 0xe0) return null;
  const version = (b1 >> 3) & 3; // 0: 2.5, 1: reserved, 2: 2, 3: 1
  const layer = 4 - ((b1 >> 1) & 3); // 1..3, or 4 when reserved
  const bitrateIndex = b2 >> 4;
  const rateIndex = (b2 >> 2) & 3;
  if (version === 1 || layer === 4 || bitrateIndex === 15 || rateIndex === 3) {
    return null;
  }
  if (bitrateIndex === 0) return null; // free format: size unknown
  const bitrate = MP3_BITRATES[layer as 1 | 2 | 3][version === 3 ? 0 : 1][
    bitrateIndex
  ] * 1000;
  const sampleRate = MP3_RATES[version][rateIndex];
  const padding = (b2 >> 1) & 1;
  const size = layer === 1
    ? (Math.floor(12 * bitrate / sampleRate) + padding) * 4
    : Math.floor(
      (layer === 3 && version !== 3 ? 72 : 144) * bitrate / sampleRate,
    ) + padding;
  const samples = layer === 1 ? 384 : layer === 3 && version !== 3 ? 576 : 1152;
  return { size, samples, sampleRate, channels: (b3 >> 6) === 3 ? 1 : 2 };
}

function probeMp3(bytes: Uint8Array, path: string) {
  let at = 0;
  if (ascii(bytes, 0, 3) === "ID3") {
    const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) |
      ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    at = 10 + size + (bytes[5] & 0x10 ? 10 : 0);
  }
  let frames = 0;
  let samples = 0;
  let first: Mp3Frame | undefined;
  while (at + 4 <= bytes.length) {
    const frame = mp3Header(bytes, at);
    // A lone sync pattern inside junk is not a frame: it must be followed by
    // another one (or the end of the file).
    const follows = frame && (at + frame.size >= bytes.length ||
      mp3Header(bytes, at + frame.size) !== null ||
      ascii(bytes, at + frame.size, 3) === "TAG");
    if (!frame || !follows) {
      at++;
      continue;
    }
    first ??= frame;
    // The first frame often only carries a Xing/Info table of contents.
    let tableOnly = false;
    if (frames === 0) {
      const body = ascii(bytes, at + 4, 40);
      tableOnly = body.includes("Xing") || body.includes("Info");
    }
    if (!tableOnly) samples += frame.samples;
    frames++;
    at += frame.size;
  }
  if (!first || samples === 0) {
    throw new Error(`${path}: no MPEG audio frames found`);
  }
  return {
    sampleRate: first.sampleRate,
    channels: first.channels,
    seconds: samples / first.sampleRate,
  };
}

function probeFlac(bytes: Uint8Array, path: string) {
  // "fLaC", then a metadata block header (type 0 = STREAMINFO, 34 bytes).
  if (bytes.length < 42 || (bytes[4] & 0x7f) !== 0) {
    throw new Error(`${path}: FLAC file has no STREAMINFO block`);
  }
  const b = bytes.subarray(18, 26);
  const sampleRate = (b[0] << 12) | (b[1] << 4) | (b[2] >> 4);
  const channels = ((b[2] >> 1) & 7) + 1;
  const total = (b[3] & 0x0f) * 0x100000000 + b[4] * 0x1000000 +
    b[5] * 0x10000 + b[6] * 0x100 + b[7];
  if (sampleRate === 0) {
    throw new Error(`${path}: FLAC STREAMINFO has no sample rate`);
  }
  return { sampleRate, channels, seconds: total / sampleRate };
}

// ---------------------------------------------------------------------------
// ffmpeg (optional)

let ffmpegMissing = false;

/**
 * Decode an Ogg/MP3/FLAC file to 32-bit float WAV at its own rate and channel
 * count with `ffmpeg`, or null when ffmpeg is absent or fails. The demuxer is
 * pinned and only the file protocol is allowed, so playlist-like content cannot
 * make it read anything else.
 */
async function ffmpegDecode(
  bytes: Uint8Array,
  kind: Container,
): Promise<Uint8Array | null> {
  if (
    ffmpegMissing || typeof Deno === "undefined" ||
    typeof Deno.Command !== "function"
  ) return null;
  let dir: string | undefined;
  try {
    dir = await Deno.makeTempDir({ prefix: "ink-audio-" });
    const input = `${dir}/input.${kind}`;
    const output = `${dir}/output.wav`;
    await Deno.writeFile(input, bytes);
    const { success } = await new Deno.Command("ffmpeg", {
      args: [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-protocol_whitelist",
        "file",
        "-f",
        kind,
        "-i",
        input,
        "-map",
        "0:a:0",
        "-vn",
        "-sn",
        "-dn",
        "-c:a",
        "pcm_f32le",
        "-f",
        "wav",
        output,
      ],
      stdin: "null",
      stdout: "null",
      stderr: "null",
      signal: AbortSignal.timeout(FFMPEG_TIMEOUT_MS),
    }).output();
    return success ? await Deno.readFile(output) : null;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) ffmpegMissing = true;
    return null;
  } finally {
    if (dir) await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}
