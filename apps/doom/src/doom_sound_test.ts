import { assert, assertEquals } from "@std/assert";
import { decode_doom_sound, encode_wav_pcm8 } from "./doom_sound.ts";
import { parse_wad } from "./wad.ts";

Deno.test("converts a Freedoom menu sound to PCM WAV", async () => {
  const bytes = await Deno.readFile(
    new URL(
      "../assets/freedoom/release/freedoom-0.13.0/freedoom1.wad",
      import.meta.url,
    ),
  );
  const wad = parse_wad(bytes);
  const sound = decode_doom_sound(wad.read("DSSTNMOV"));
  const wav = encode_wav_pcm8(sound);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

  assertEquals(sound.sample_rate, 11025);
  assert(sound.samples.length > 2000);
  assertEquals(new TextDecoder().decode(wav.subarray(0, 4)), "RIFF");
  assertEquals(new TextDecoder().decode(wav.subarray(8, 12)), "WAVE");
  assertEquals(view.getUint16(20, true), 1);
  assertEquals(view.getUint16(22, true), 1);
  assertEquals(view.getUint16(34, true), 8);
  assertEquals(view.getUint32(40, true), sound.samples.length);
  assertEquals(wav.length, 44 + sound.samples.length);
});
