import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "@std/assert";
import {
  decodeWav,
  normalizeWav,
  probeAudio,
  resample,
  transcodeAudio,
} from "./audio.ts";

// --- Fixtures ---------------------------------------------------------------

interface WavSpec {
  rate: number;
  channels: number;
  /** Frames of audio. */
  frames: number;
  bits?: 8 | 16 | 24 | 32 | 64;
  float?: boolean;
  extensible?: boolean;
  mask?: number;
  /** Signal in -1..1 for a frame index and channel. */
  signal: (frame: number, channel: number) => number;
  /** Chunks written before `fmt `, after the audio, or with odd sizes. */
  before?: Uint8Array;
  after?: Uint8Array;
  /** Declared data size, to fake truncated or streamed files. */
  declare?: number;
  /** Bytes cut off the end of the whole file. */
  cut?: number;
}

const text = (s: string) => new TextEncoder().encode(s);

function chunk(id: string, body: Uint8Array, pad = true): Uint8Array {
  const odd = pad && body.length % 2 === 1;
  const out = new Uint8Array(8 + body.length + (odd ? 1 : 0));
  out.set(text(id), 0);
  new DataView(out.buffer).setUint32(4, body.length, true);
  out.set(body, 8);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function makeWav(spec: WavSpec): Uint8Array {
  const bits = spec.bits ?? 16;
  const width = bits / 8;
  const float = spec.float ?? false;
  const fmtBody = new Uint8Array(spec.extensible ? 40 : 16);
  const fv = new DataView(fmtBody.buffer);
  fv.setUint16(0, spec.extensible ? 0xfffe : float ? 3 : 1, true);
  fv.setUint16(2, spec.channels, true);
  fv.setUint32(4, spec.rate, true);
  fv.setUint32(8, spec.rate * spec.channels * width, true);
  fv.setUint16(12, spec.channels * width, true);
  fv.setUint16(14, bits, true);
  if (spec.extensible) {
    fv.setUint16(16, 22, true);
    fv.setUint16(18, bits, true);
    fv.setUint32(20, spec.mask ?? 0, true);
    fv.setUint16(24, float ? 3 : 1, true); // start of the sub-format GUID
    fmtBody.set(
      [0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71],
      26,
    );
  }

  const samples = new Uint8Array(spec.frames * spec.channels * width);
  const v = new DataView(samples.buffer);
  for (let i = 0; i < spec.frames; i++) {
    for (let c = 0; c < spec.channels; c++) {
      const x = spec.signal(i, c);
      const at = (i * spec.channels + c) * width;
      if (float && bits === 32) v.setFloat32(at, x, true);
      else if (float) v.setFloat64(at, x, true);
      else if (bits === 8) samples[at] = Math.round(x * 127) + 128;
      else if (bits === 16) v.setInt16(at, Math.round(x * 32767), true);
      else if (bits === 24) {
        const n = Math.round(x * 8388607);
        samples[at] = n & 0xff;
        samples[at + 1] = (n >> 8) & 0xff;
        samples[at + 2] = (n >> 16) & 0xff;
      } else v.setInt32(at, Math.round(x * 2147483647), true);
    }
  }

  const data = chunk("data", samples);
  if (spec.declare !== undefined) {
    new DataView(data.buffer).setUint32(4, spec.declare, true);
  }
  const body = concat(
    text("WAVE"),
    chunk("fmt ", fmtBody),
    spec.before ?? new Uint8Array(0),
    data,
    spec.after ?? new Uint8Array(0),
  );
  const out = concat(text("RIFF"), new Uint8Array(4), body);
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  return spec.cut ? out.subarray(0, out.length - spec.cut) : out;
}

/** Deterministic noise in -0.5..0.5. */
function noise(seed: number) {
  let state = seed >>> 0;
  return () =>
    (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32 - 0.5;
}

/** Two seconds of a 200 Hz to 8 kHz sweep over faint noise, 44.1 kHz stereo. */
const SWEEP_RATE = 44100;
const SWEEP_SECONDS = 2;
function sweepSignal() {
  const rnd = noise(7);
  let phase = 0;
  const left = new Float64Array(SWEEP_RATE * SWEEP_SECONDS);
  const right = new Float64Array(left.length);
  for (let i = 0; i < left.length; i++) {
    phase += 2 * Math.PI * (200 + 7800 * i / left.length) / SWEEP_RATE;
    left[i] = 0.5 * Math.sin(phase) + 0.02 * rnd();
    right[i] = 0.5 * Math.sin(phase + 1) + 0.02 * rnd();
  }
  return [left, right];
}
function sweepWav(): Uint8Array {
  const channels = sweepSignal();
  return makeWav({
    rate: SWEEP_RATE,
    channels: 2,
    frames: channels[0].length,
    signal: (i, c) => channels[c][i],
  });
}

// --- Ogg inspection (independent of the writer) -----------------------------

interface OggPage {
  flags: number;
  granule: number;
  serial: number;
  sequence: number;
  packets: Uint8Array[];
  crcOk: boolean;
}

/** Bit-at-a-time CRC-32, polynomial 0x04c11db7, no reflection, no final xor. */
function slowCrc(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc = (crc ^ (byte << 24)) >>> 0;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1) >>> 0;
    }
  }
  return crc;
}

function readOgg(bytes: Uint8Array): OggPage[] {
  const pages: OggPage[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  while (at < bytes.length) {
    assertEquals(new TextDecoder().decode(bytes.subarray(at, at + 4)), "OggS");
    assertEquals(bytes[at + 4], 0, "stream structure version");
    const count = bytes[at + 26];
    const lacing = bytes.subarray(at + 27, at + 27 + count);
    const size = lacing.reduce((n, l) => n + l, 0);
    const end = at + 27 + count + size;
    assert(end <= bytes.length, "page runs past the end of the file");

    const copy = bytes.slice(at, end);
    const stored = view.getUint32(at + 22, true);
    new DataView(copy.buffer).setUint32(22, 0, true);

    const packets: Uint8Array[] = [];
    let body = at + 27 + count;
    let length = 0;
    for (const l of lacing) {
      length += l;
      if (l < 255) {
        packets.push(bytes.subarray(body, body + length));
        body += length;
        length = 0;
      }
    }
    assertEquals(length, 0, "packet continues past the page");
    pages.push({
      flags: bytes[at + 5],
      granule: view.getUint32(at + 6, true) +
        view.getUint32(at + 10, true) * 2 ** 32,
      serial: view.getUint32(at + 14, true),
      sequence: view.getUint32(at + 18, true),
      packets,
      crcOk: slowCrc(copy) === stored,
    });
    at = end;
  }
  return pages;
}

// --- ffmpeg helpers (optional) ----------------------------------------------

async function ffmpegAvailable(encoder?: string): Promise<boolean> {
  try {
    const out = await new Deno.Command("ffmpeg", {
      args: ["-hide_banner", encoder ? "-encoders" : "-version"],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!out.success) return false;
    return !encoder ||
      new TextDecoder().decode(out.stdout).includes(` ${encoder} `);
  } catch {
    return false;
  }
}

async function ffmpeg(args: string[], input: Uint8Array, ext: string) {
  const dir = await Deno.makeTempDir({ prefix: "ink-audio-test-" });
  try {
    await Deno.writeFile(`${dir}/in.${ext}`, input);
    const out = await new Deno.Command("ffmpeg", {
      args: [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        `${dir}/in.${ext}`,
        ...args,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(
      out.success,
      `ffmpeg failed: ${new TextDecoder().decode(out.stderr)}`,
    );
    return out.stdout;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Decode to interleaved float32 at the given rate and channel count. */
async function decodeWithFfmpeg(
  bytes: Uint8Array,
  ext: string,
  rate: number,
  channels: number,
): Promise<Float32Array> {
  const raw = await ffmpeg(
    ["-f", "f32le", "-ar", String(rate), "-ac", String(channels), "pipe:1"],
    bytes,
    ext,
  );
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}

/** SNR in dB of `decoded` against the stereo `source` shifted by `lag` frames. */
function snr(source: Float64Array[], decoded: Float32Array, lag: number) {
  let signal = 0;
  let error = 0;
  const n = source[0].length;
  for (let i = 2000; i < n - 2000; i++) {
    for (let c = 0; c < source.length; c++) {
      const a = source[c][i];
      const b = decoded[(i + lag) * source.length + c];
      signal += a * a;
      error += (a - b) ** 2;
    }
  }
  return 10 * Math.log10(signal / error);
}

// --- Tests ------------------------------------------------------------------

Deno.test("audio: Ogg Opus structure of a stereo 44.1 kHz sweep", async () => {
  const wav = sweepWav();
  const start = performance.now();
  const result = await transcodeAudio(wav, "sweep.wav");
  const ms = performance.now() - start;

  assertEquals(result.codec, "opus");
  assertEquals(result.ext, "ogg");
  assertEquals(result.mime, "audio/ogg");
  assertEquals(result.note, undefined);
  assertEquals(result.info.sampleRate, 48000);
  assertEquals(result.info.channels, 2);
  assertEquals(result.info.seconds, SWEEP_SECONDS);
  assertEquals(result.info.sourceBytes, wav.length);
  assertEquals(result.info.outputBytes, result.bytes.length);
  const ratio = result.bytes.length / wav.length;
  assert(ratio < 0.15, `Opus is ${(ratio * 100).toFixed(1)}% of the WAV`);
  console.log(
    `  sweep: ${wav.length} -> ${result.bytes.length} bytes ` +
      `(${(ratio * 100).toFixed(1)}%) in ${ms.toFixed(0)} ms`,
  );

  const pages = readOgg(result.bytes);
  assert(pages.length >= 3);
  assert(pages.every((p) => p.crcOk), "every page CRC is valid");
  assertEquals(pages.map((p) => p.sequence), pages.map((_, i) => i));
  assertEquals(new Set(pages.map((p) => p.serial)).size, 1);

  // OpusHead: alone on the first, beginning-of-stream page.
  const [first, second] = pages;
  assertEquals(first.flags, 0x02);
  assertEquals(first.granule, 0);
  assertEquals(first.packets.length, 1);
  const head = first.packets[0];
  const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  assertEquals(new TextDecoder().decode(head.subarray(0, 8)), "OpusHead");
  assertEquals(head[8], 1, "version");
  assertEquals(head[9], 2, "channels");
  assertEquals(hv.getUint16(10, true), 312, "pre-skip");
  assertEquals(hv.getUint32(12, true), SWEEP_RATE, "input sample rate");
  assertEquals(hv.getInt16(16, true), 0, "output gain");
  assertEquals(head[18], 0, "channel mapping family");
  assertEquals(head.length, 19);

  // OpusTags on its own page.
  assertEquals(second.flags, 0);
  assertEquals(second.granule, 0);
  assertEquals(
    new TextDecoder().decode(second.packets[0].subarray(0, 8)),
    "OpusTags",
  );

  // Audio: EOS only on the last page, granule positions that count the
  // pre-skip and end exactly at the end of the sound.
  const audio = pages.slice(2);
  assertEquals(audio.map((p) => p.flags & 0x04), [
    ...audio.slice(1).map(() => 0),
    0x04,
  ]);
  assert(audio.every((p) => (p.flags & 0x02) === 0));
  let packets = 0;
  let previous = 0;
  for (const page of audio) {
    packets += page.packets.length;
    assert(page.granule > previous, "granule positions increase");
    previous = page.granule;
  }
  assertEquals(audio.at(-1)!.granule, 312 + 96000);
  assertEquals(packets, Math.ceil((96000 + 312) / 960));
  // Every packet is a single 20 ms frame (TOC code 0 and a 20 ms config).
  for (const page of audio) {
    for (const packet of page.packets) {
      assertEquals(packet[0] & 0x03, 0, "one frame per packet");
    }
  }
});

Deno.test("audio: deterministic output and bitrate option", async () => {
  const wav = sweepWav();
  const a = await transcodeAudio(wav, "a.wav");
  const b = await transcodeAudio(wav.slice(), "b/other-name.wav");
  assertEquals(a.bytes, b.bytes);

  const low = await transcodeAudio(wav, "a.wav", { bitrate: 32000 });
  assert(low.bytes.length < a.bytes.length * 0.5);
  assertEquals(
    await transcodeAudio(wav, "a.wav", { bitrate: 32000 }).then((r) => r.bytes),
    low.bytes,
  );

  // The stream serial follows the input, not a clock.
  const other = sweepWav();
  other[other.length - 3] ^= 0x55;
  const c = await transcodeAudio(other, "a.wav");
  assertNotEquals(readOgg(c.bytes)[0].serial, readOgg(a.bytes)[0].serial);

  await assertRejects(
    () => transcodeAudio(wav, "a.wav", { bitrate: 100 }),
    RangeError,
    "bitrate",
  );
});

Deno.test("audio: decoded Opus matches the source", async (t) => {
  if (!await ffmpegAvailable()) {
    console.log("  ffmpeg not found: skipping decode checks");
    return;
  }
  const source = sweepSignal();
  const result = await transcodeAudio(sweepWav(), "sweep.wav");

  await t.step("duration within one frame at 48 kHz", async () => {
    const decoded = await decodeWithFfmpeg(result.bytes, "ogg", 48000, 2);
    const seconds = decoded.length / 2 / 48000;
    assert(
      Math.abs(seconds - SWEEP_SECONDS) <= 0.02,
      `decoded ${seconds} s`,
    );
  });

  await t.step("SNR and alignment against the source", async () => {
    const decoded = await decodeWithFfmpeg(result.bytes, "ogg", SWEEP_RATE, 2);
    assertAlmostEquals(decoded.length / 2, source[0].length, 8);
    const aligned = snr(source, decoded, 0);
    console.log(`  SNR ${aligned.toFixed(1)} dB`);
    assert(aligned > 20, `SNR ${aligned} dB`);
    // The pre-skip must put the sound exactly where it was.
    for (const lag of [-3, -2, -1, 1, 2, 3]) {
      assert(snr(source, decoded, lag) < aligned, `lag ${lag} is better`);
    }
  });

  await t.step(
    "ffmpeg decodes the whole stream without complaint",
    async () => {
      const out = await ffmpeg(
        ["-f", "null", "-"],
        result.bytes,
        "ogg",
      );
      assertEquals(out.length, 0);
    },
  );
});

Deno.test("audio: mono at 22.05 kHz is resampled and stays mono", async () => {
  const wav = makeWav({
    rate: 22050,
    channels: 1,
    frames: 22050,
    bits: 24,
    signal: (i) => 0.4 * Math.sin(2 * Math.PI * 1000 * i / 22050),
  });
  const result = await transcodeAudio(wav, "tone.wav");
  assertEquals(result.codec, "opus");
  assertEquals(result.info.channels, 1);
  assertEquals(result.info.seconds, 1);
  const pages = readOgg(result.bytes);
  assert(pages.every((p) => p.crcOk));
  const head = pages[0].packets[0];
  assertEquals(head[9], 1);
  assertEquals(
    new DataView(head.buffer, head.byteOffset).getUint32(12, true),
    22050,
  );
  assertEquals(pages.at(-1)!.granule, 312 + 48000);
  // 64 kbit/s by default for mono.
  console.log(`  mono: ${result.bytes.length} bytes for 1 s`);
  assert(result.bytes.length < 64000 / 8 * 1.3);

  if (await ffmpegAvailable()) {
    const decoded = await decodeWithFfmpeg(result.bytes, "ogg", 22050, 1);
    assertAlmostEquals(decoded.length, 22050, 8);
    let signal = 0;
    let error = 0;
    for (let i = 2000; i < 20000; i++) {
      const ref = 0.4 * Math.sin(2 * Math.PI * 1000 * i / 22050);
      signal += ref * ref;
      error += (ref - decoded[i]) ** 2;
    }
    const db = 10 * Math.log10(signal / error);
    assert(db > 25, `tone SNR ${db} dB`);
  }
});

Deno.test("audio: 5.1 folds down to stereo", async () => {
  // Only the front centre plays: it must come out equally in both channels.
  const wav = makeWav({
    rate: 48000,
    channels: 6,
    frames: 4800,
    extensible: true,
    mask: 0x3f,
    signal: (i, c) => c === 2 ? 0.5 * Math.sin(i * 0.1) : 0,
  });
  const result = await transcodeAudio(wav, "surround.wav");
  assertEquals(result.codec, "opus");
  assertEquals(result.info.channels, 2);
  assertEquals(readOgg(result.bytes)[0].packets[0][9], 2);

  const normal = normalizeWav(wav, "surround.wav");
  assertEquals(normal.channels, 2);
  assertEquals(normal.frames, 4800);
  const pcm = decodeWav(normal.bytes);
  assertEquals(pcm.channels.length, 2);
  for (let i = 0; i < 4800; i += 97) {
    assertAlmostEquals(pcm.channels[0][i], pcm.channels[1][i], 1e-6);
    assertAlmostEquals(
      pcm.channels[0][i],
      0.5 * Math.sin(i * 0.1) * Math.SQRT1_2 / (1 + 2 * Math.SQRT1_2),
      1e-3,
    );
  }
});

Deno.test("audio: WAV decoding of every supported layout", () => {
  const signal = (i: number, c: number) =>
    0.6 * Math.sin(i * 0.05 + c) * (i % 40 < 20 ? 1 : -0.5);
  const base = { rate: 32000, channels: 2, frames: 300, signal };
  const cases: [string, WavSpec, number][] = [
    ["8-bit", { ...base, bits: 8 }, 0.02],
    ["16-bit", { ...base, bits: 16 }, 1e-4],
    ["24-bit", { ...base, bits: 24 }, 1e-6],
    ["32-bit int", { ...base, bits: 32 }, 1e-6],
    ["32-bit float", { ...base, bits: 32, float: true }, 1e-6],
    ["64-bit float", { ...base, bits: 64, float: true }, 1e-7],
    ["extensible 16", { ...base, extensible: true, mask: 3 }, 1e-4],
    ["extensible float", {
      ...base,
      bits: 32,
      float: true,
      extensible: true,
      mask: 3,
    }, 1e-6],
  ];
  for (const [name, spec, tolerance] of cases) {
    const pcm = decodeWav(makeWav(spec), name);
    assertEquals(pcm.sampleRate, 32000, name);
    assertEquals(pcm.channels.length, 2, name);
    assertEquals(pcm.channels[0].length, 300, name);
    assertEquals(pcm.mask, 3, name);
    for (let i = 0; i < 300; i++) {
      assertAlmostEquals(
        pcm.channels[1][i],
        signal(i, 1),
        tolerance,
        `${name} ${i}`,
      );
    }
  }

  // Odd-sized chunks before and after the audio are padded to even size.
  const odd = chunk("LIST", new Uint8Array(5));
  const padded = decodeWav(makeWav({ ...base, before: odd, after: odd }));
  assertEquals(padded.channels[0].length, 300);
  assertAlmostEquals(padded.channels[0][123], signal(123, 0), 1e-4);

  // ...and some writers leave the pad byte out.
  const bare = chunk("LIST", new Uint8Array(5), false);
  const unpadded = decodeWav(makeWav({ ...base, before: bare, after: bare }));
  assertEquals(unpadded.channels[0].length, 300);
  assertAlmostEquals(unpadded.channels[0][123], signal(123, 0), 1e-4);

  // Chunks after the audio are ignored.
  const trailing = decodeWav(
    makeWav({ ...base, after: chunk("smpl", new Uint8Array(60)) }),
  );
  assertEquals(trailing.channels[0].length, 300);

  // Non-finite floats become silence.
  const bad = makeWav({
    ...base,
    bits: 32,
    float: true,
    signal: (i) => i === 5 ? NaN : i === 6 ? Infinity : 0.25,
  });
  const clean = decodeWav(bad);
  assertEquals([clean.channels[0][5], clean.channels[0][6]], [0, 0]);
});

Deno.test("audio: truncated and streamed WAV files", () => {
  const signal = (i: number) => 0.5 * Math.sin(i * 0.2);
  const spec = { rate: 16000, channels: 2, frames: 1000, signal };
  // Cut mid-frame: whole frames survive.
  const cut = decodeWav(makeWav({ ...spec, cut: 1001 }));
  assertEquals(cut.channels[0].length, 1000 - 251);
  // The header promises more than the file holds.
  const lying = decodeWav(makeWav({ ...spec, declare: 1_000_000, cut: 400 }));
  assertEquals(lying.channels[0].length, 900);
  // Streamed writers put 0xffffffff in the size fields.
  const streamed = makeWav({ ...spec, declare: 0xffffffff });
  new DataView(streamed.buffer).setUint32(4, 0xffffffff, true);
  assertEquals(decodeWav(streamed).channels[0].length, 1000);
  // An empty data chunk is an error, not silence.
  assertThrows(
    () => decodeWav(makeWav({ ...spec, frames: 0 }), "empty.wav"),
    Error,
    "empty.wav",
  );
  // No data chunk at all.
  const noData = makeWav(spec).subarray(0, 36);
  assertThrows(() => decodeWav(noData, "nodata.wav"), Error, "nodata.wav");
});

Deno.test("audio: normalizeWav writes clean 16-bit PCM", () => {
  const wav = makeWav({
    rate: 44100,
    channels: 2,
    frames: 500,
    bits: 24,
    signal: (i, c) => 0.5 * Math.sin(i * 0.1 + c),
    before: chunk("LIST", text("INFOISFT\x05\0\0\0ink\0\0")),
    after: chunk("junk", new Uint8Array(33)),
  });
  const out = normalizeWav(wav);
  assertEquals(out.bytes.length, 44 + 500 * 4);
  assertEquals(new TextDecoder().decode(out.bytes.subarray(0, 4)), "RIFF");
  const v = new DataView(out.bytes.buffer);
  assertEquals(v.getUint32(4, true), out.bytes.length - 8);
  assertEquals(v.getUint16(20, true), 1);
  assertEquals(v.getUint16(34, true), 16);
  assertEquals(v.getUint32(24, true), 44100);
  assertEquals(v.getUint32(40, true), 2000);
  const back = decodeWav(out.bytes);
  assertAlmostEquals(back.channels[1][250], 0.5 * Math.sin(25 + 1), 1e-4);
});

Deno.test("audio: resampler keeps duration and tones", () => {
  for (const [from, to] of [[44100, 48000], [96000, 48000], [8000, 48000]]) {
    const frequency = 1500;
    const input = new Float32Array(from);
    for (let i = 0; i < from; i++) {
      input[i] = Math.sin(2 * Math.PI * frequency * i / from);
    }
    const out = resample(input, from, to);
    assertEquals(out.length, to);
    let signal = 0;
    let error = 0;
    for (let j = 1000; j < to - 1000; j++) {
      const ref = Math.sin(2 * Math.PI * frequency * j / to);
      signal += ref * ref;
      error += (out[j] - ref) ** 2;
    }
    const db = 10 * Math.log10(signal / error);
    assert(db > 70, `${from} -> ${to}: ${db} dB`);
  }
  const same = new Float32Array(10);
  assert(resample(same, 48000, 48000) === same);
});

Deno.test("audio: garbage and unsupported files are rejected", async () => {
  const wavHead = makeWav({
    rate: 8000,
    channels: 1,
    frames: 10,
    signal: () => 0,
  });
  const cases: [string, Uint8Array, string][] = [
    ["empty.wav", new Uint8Array(0), "empty"],
    ["text.mp3", text("this is not a sound at all"), "not a WAV"],
    [
      "png.ogg",
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0]),
      "png.ogg",
    ],
    [
      "avi.wav",
      concat(text("RIFF"), new Uint8Array(4), text("AVI LIST")),
      "avi.wav",
    ],
    ["rf64.wav", concat(text("RF64"), new Uint8Array(8)), "RF64"],
    [
      "bad.ogg",
      concat(text("OggS"), new Uint8Array([0, 2]), new Uint8Array(40)),
      "bad.ogg",
    ],
    [
      "id3.mp3",
      concat(
        text("ID3"),
        new Uint8Array([4, 0, 0, 0, 0, 0, 10]),
        new Uint8Array(40),
      ),
      "id3.mp3",
    ],
    ["tiny.flac", text("fLaC"), "tiny.flac"],
    ["cut.wav", wavHead.subarray(0, 30), "cut.wav"],
  ];
  for (const [name, bytes, message] of cases) {
    await assertRejects(() => transcodeAudio(bytes, name), Error, message);
  }
  // A format the browser cannot be trusted with, such as A-law.
  const alaw = makeWav({
    rate: 8000,
    channels: 1,
    frames: 10,
    signal: () => 0,
  });
  new DataView(alaw.buffer).setUint16(20, 6, true);
  await assertRejects(() => transcodeAudio(alaw, "alaw.wav"), Error, "0x6");
});

Deno.test("audio: Ogg Opus is shipped unchanged", async () => {
  const opus = (await transcodeAudio(sweepWav(), "sweep.wav")).bytes;
  const again = await transcodeAudio(opus, "sweep.ogg");
  assertEquals(again.codec, "passthrough");
  assertEquals(again.bytes, opus);
  assertEquals(again.ext, "ogg");
  assertEquals(again.mime, "audio/ogg");
  assertEquals(again.info.channels, 2);
  assertEquals(again.info.sampleRate, 48000);
  assertAlmostEquals(again.info.seconds, SWEEP_SECONDS, 1e-9);
  assertEquals(again.info.outputBytes, opus.length);
});

Deno.test("audio: MP3 and FLAC headers are described", () => {
  // 100 MPEG-1 layer III frames, 128 kbit/s, 44.1 kHz, joint stereo; the
  // third frame is padded.
  const frame = (padding: boolean) => {
    const f = new Uint8Array(padding ? 418 : 417);
    f.set([0xff, 0xfb, padding ? 0x92 : 0x90, 0x44]);
    return f;
  };
  const frames = Array.from({ length: 100 }, (_, i) => frame(i === 2));
  const mp3 = concat(...frames);
  const info = probeAudio(mp3, "tone.mp3");
  assertEquals(info.ext, "mp3");
  assertEquals(info.mime, "audio/mpeg");
  assertEquals(info.codec, "passthrough");
  assertEquals(info.info.sampleRate, 44100);
  assertEquals(info.info.channels, 2);
  assertAlmostEquals(info.info.seconds, 100 * 1152 / 44100, 1e-9);

  // An ID3v2 tag in front is skipped (its size is 4 x 7 bits).
  const tag = concat(
    text("ID3"),
    new Uint8Array([4, 0, 0, 0, 0, 1, 0]),
    new Uint8Array(128),
  );
  const tagged = probeAudio(
    concat(tag, mp3, text("TAG"), new Uint8Array(125)),
    "t.mp3",
  );
  assertAlmostEquals(tagged.info.seconds, 100 * 1152 / 44100, 1e-9);

  // Mono MPEG-2 layer III at 22.05 kHz has 576 samples per frame.
  const mono = new Uint8Array(72 * 64000 / 22050 | 0);
  mono.set([0xff, 0xf3, 0x80, 0xc4]);
  const monos = probeAudio(
    concat(...Array.from({ length: 10 }, () => mono)),
    "m.mp3",
  );
  assertEquals(monos.info.channels, 1);
  assertEquals(monos.info.sampleRate, 22050);
  assertAlmostEquals(monos.info.seconds, 10 * 576 / 22050, 1e-9);

  // FLAC: STREAMINFO of 48 kHz, 2 channels, 16 bit, 96000 samples.
  const flac = new Uint8Array(42);
  flac.set(text("fLaC"));
  flac[4] = 0x80;
  flac[7] = 34;
  const rate = 48000;
  flac[18] = rate >> 12;
  flac[19] = (rate >> 4) & 0xff;
  flac[20] = ((rate & 0xf) << 4) | (1 << 1);
  flac[21] = 0xf0 | 0;
  new DataView(flac.buffer).setUint32(22, 96000);
  const flacInfo = probeAudio(flac, "a.flac");
  assertEquals(flacInfo.info.sampleRate, 48000);
  assertEquals(flacInfo.info.channels, 2);
  assertEquals(flacInfo.info.seconds, 2);
  assertEquals(flacInfo.mime, "audio/flac");
});

Deno.test("audio: ffmpeg decodes Ogg Vorbis and MP3 into Opus", async (t) => {
  if (!await ffmpegAvailable()) {
    console.log("  ffmpeg not found: skipping");
    return;
  }
  const wav = sweepWav();
  const cases: [string, string][] = [
    ["libmp3lame", "mp3"],
    ["libvorbis", "ogg"],
  ];
  for (const [encoder, ext] of cases) {
    if (!await ffmpegAvailable(encoder)) continue;
    await t.step(`${ext} via ${encoder}`, async () => {
      const source = await ffmpeg(
        ["-c:a", encoder, "-b:a", "192k", "-f", ext, "pipe:1"],
        wav,
        "wav",
      );
      const result = await transcodeAudio(source, `sweep.${ext}`);
      assertEquals(result.codec, "opus", `${ext} should be transcoded`);
      assertEquals(result.ext, "ogg");
      assert(result.bytes.length < source.length);
      assert(readOgg(result.bytes).every((p) => p.crcOk));
      assertAlmostEquals(result.info.seconds, SWEEP_SECONDS, 0.1);
      // Same input, same bytes.
      const again = await transcodeAudio(source.slice(), `sweep.${ext}`);
      assertEquals(again.bytes, result.bytes);
      const decoded = await decodeWithFfmpeg(result.bytes, "ogg", 48000, 2);
      assertAlmostEquals(decoded.length / 2 / 48000, SWEEP_SECONDS, 0.1);
    });
  }
});

Deno.test("audio: degrades without ffmpeg or without the encoder", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ink-audio-test-" });
  try {
    const wav = makeWav({
      rate: 22050,
      channels: 2,
      frames: 11025,
      signal: (i, c) => 0.3 * Math.sin(i * (0.05 + c * 0.01)),
    });
    // Frames of silence with valid MPEG-1 layer III headers: ffmpeg, when
    // present, may or may not accept them, so only the invariants are checked.
    const mp3 = concat(
      ...Array.from({ length: 40 }, () => {
        const frame = new Uint8Array(417);
        frame.set([0xff, 0xfb, 0x90, 0x44]);
        return frame;
      }),
    );
    await Deno.writeFile(`${dir}/in.wav`, wav);
    await Deno.writeFile(`${dir}/in.mp3`, mp3);
    await Deno.writeTextFile(
      `${dir}/run.ts`,
      `import { transcodeAudio } from ${
        JSON.stringify(import.meta.resolve("./audio.ts"))
      };
      const [wavPath, mp3Path] = Deno.args;
      const out = [];
      for (const path of [wavPath, mp3Path]) {
        const input = await Deno.readFile(path);
        const r = await transcodeAudio(input, path);
        out.push({
          codec: r.codec,
          note: r.note,
          ext: r.ext,
          length: r.bytes.length,
          same: r.bytes.length === input.length && r.bytes.every((b, i) => b === input[i]),
          channels: r.info.channels,
        });
      }
      console.log(JSON.stringify(out));`,
    );
    // Only the cache locations and an empty PATH reach the child.
    const env: Record<string, string> = { PATH: dir };
    for (const name of ["HOME", "DENO_DIR", "XDG_CACHE_HOME"]) {
      const value = Deno.env.get(name);
      if (value) env[name] = value;
    }
    const run = async (args: string[]) => {
      const out = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          ...args,
          `${dir}/run.ts`,
          `${dir}/in.wav`,
          `${dir}/in.mp3`,
        ],
        env,
        clearEnv: true,
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(out.success, new TextDecoder().decode(out.stderr));
      return JSON.parse(new TextDecoder().decode(out.stdout));
    };

    // No executable on PATH: the WAV is still encoded, the MP3 is shipped as is.
    const config = new URL(import.meta.resolve("../../deno.json")).pathname;
    const noFfmpeg = await run(["--config", config]);
    assertEquals(noFfmpeg[0].codec, "opus");
    assertEquals(noFfmpeg[0].note, undefined);
    assertEquals(noFfmpeg[1].codec, "passthrough");
    assertEquals(noFfmpeg[1].same, true);
    assertEquals(noFfmpeg[1].ext, "mp3");

    // No import map: the encoder cannot be found, so the WAV is normalised.
    const noEncoder = await run(["--no-config"]);
    assertEquals(noEncoder[0].codec, "wav-pcm16");
    assertEquals(noEncoder[0].ext, "wav");
    assertEquals(noEncoder[0].length, 44 + 11025 * 4);
    assert(String(noEncoder[0].note).includes("Opus encoder unavailable"));
    assertEquals(noEncoder[1].codec, "passthrough");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
