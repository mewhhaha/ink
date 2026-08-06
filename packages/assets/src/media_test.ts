import { assertEquals, assertThrows } from "@std/assert";
import {
  decode_audio,
  decode_image,
  texture_mip_level_count,
} from "./media.ts";

Deno.test("image decoding copies validated pixels and preserves texture metadata", async () => {
  const original = new Uint8Array(4 * 2 * 4);
  const result = await decode_image({
    decode() {
      return Promise.resolve({
        width: 4,
        height: 2,
        rgba8: original,
        color_space: "srgb",
        mip_level_count: 3,
      });
    },
  }, {
    bytes: new Uint8Array([1]),
    mime_type: "image/png",
    color_space: "srgb",
    mip_policy: "generate-complete-chain",
  });

  if (result.type !== "ready") throw new Error(result.type);
  original[0] = 255;
  assertEquals(result.value.rgba8[0], 0);
  assertEquals(result.value.mip_level_count, 3);
});

Deno.test("media decoding reports an absent platform capability explicitly", async () => {
  assertEquals(
    await decode_audio(undefined, {
      bytes: new Uint8Array(),
      mime_type: "audio/ogg",
    }),
    { type: "capability_unavailable", capability: "audio decode" },
  );
});

Deno.test("audio decoding rejects channels with inconsistent frame counts", async () => {
  const result = await decode_audio({
    decode() {
      return Promise.resolve({
        sample_rate: 48_000,
        frame_count: 2,
        channels: [new Float32Array(1)],
      });
    },
  }, {
    bytes: new Uint8Array(),
    mime_type: "audio/wav",
  });
  assertEquals(result, {
    type: "failed",
    reason: "decoded audio channel 0 has 1 frames; expected 2",
  });
});

Deno.test("texture mip counts cover rectangular complete chains", () => {
  assertEquals(texture_mip_level_count(8, 2, "generate-complete-chain"), 4);
  assertEquals(texture_mip_level_count(8, 2, "source-only"), 1);
  assertThrows(
    () => texture_mip_level_count(0, 2, "source-only"),
    Error,
    "texture width 0",
  );
});
