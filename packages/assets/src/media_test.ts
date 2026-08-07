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

Deno.test("image decoding snapshots requests before awaiting the platform", async () => {
  let received: Uint8Array | undefined;
  let finish: (() => void) | undefined;
  const bytes = new Uint8Array([1, 2]);
  const pending = decode_image({
    async decode(request) {
      received = request.bytes;
      await new Promise<void>((resolve) => finish = resolve);
      return {
        width: 1,
        height: 1,
        rgba8: new Uint8Array(4),
        color_space: request.color_space,
        mip_level_count: 1,
      };
    },
  }, {
    bytes,
    mime_type: " image/png ",
    color_space: "srgb",
    mip_policy: "source-only",
  });
  bytes.fill(9);
  assertEquals(received, new Uint8Array([1, 2]));
  finish!();
  assertEquals((await pending).type, "ready");
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

Deno.test("media decoding reports malformed requests without invoking the platform", async () => {
  const capability = {
    decode(): Promise<never> {
      throw new Error("platform must not be invoked");
    },
  };
  assertEquals(
    await decode_image(capability, {
      bytes: [],
      mime_type: "image/png",
      color_space: "srgb",
      mip_policy: "source-only",
    } as never),
    {
      type: "failed",
      reason: "image bytes must be a Uint8Array",
    },
  );
  assertEquals(
    await decode_audio(capability, {
      bytes: new Uint8Array(),
      mime_type: 42,
    } as never),
    {
      type: "failed",
      reason: "audio MIME type must be a string",
    },
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
  assertEquals(
    await decode_audio({
      decode() {
        return Promise.resolve({
          sample_rate: 48_000,
          frame_count: 1,
          channels: [new Float32Array([Number.NaN])],
        });
      },
    }, { bytes: new Uint8Array(), mime_type: "audio/wav" }),
    {
      type: "failed",
      reason: "decoded audio channel 0 sample 0 must be finite",
    },
  );
});

Deno.test("texture mip counts cover rectangular complete chains", () => {
  assertEquals(texture_mip_level_count(8, 2, "generate-complete-chain"), 4);
  assertEquals(texture_mip_level_count(8, 2, "source-only"), 1);
  assertThrows(
    () => texture_mip_level_count(0, 2, "source-only"),
    Error,
    "texture width 0",
  );
  assertThrows(
    () => texture_mip_level_count(1, 1, "unknown" as never),
    Error,
    'texture mip policy "unknown" is invalid',
  );
});
