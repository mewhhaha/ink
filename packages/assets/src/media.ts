export type TextureColorSpace = "linear-srgb" | "srgb" | "display-p3";
export type TextureMipPolicy = "source-only" | "generate-complete-chain";

export interface ImageDecodeRequest {
  readonly bytes: Uint8Array;
  readonly mime_type: string;
  readonly color_space: TextureColorSpace;
  readonly mip_policy: TextureMipPolicy;
}

export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  readonly rgba8: Uint8Array;
  readonly color_space: TextureColorSpace;
  readonly mip_level_count: number;
}

export interface ImageDecodeCapability {
  decode(
    request: ImageDecodeRequest,
    signal: AbortSignal,
  ): Promise<DecodedImage>;
}

export interface AudioDecodeRequest {
  readonly bytes: Uint8Array;
  readonly mime_type: string;
}

export interface DecodedAudio {
  readonly sample_rate: number;
  readonly frame_count: number;
  readonly channels: readonly Float32Array[];
}

export interface AudioDecodeCapability {
  decode(
    request: AudioDecodeRequest,
    signal: AbortSignal,
  ): Promise<DecodedAudio>;
}

export type MediaDecodeResult<Value> =
  | { readonly type: "ready"; readonly value: Value }
  | { readonly type: "cancelled" }
  | { readonly type: "capability_unavailable"; readonly capability: string }
  | { readonly type: "failed"; readonly reason: string };

export async function decode_image(
  capability: ImageDecodeCapability | undefined,
  request: ImageDecodeRequest,
  signal: AbortSignal = new AbortController().signal,
): Promise<MediaDecodeResult<DecodedImage>> {
  if (capability === undefined) {
    return { type: "capability_unavailable", capability: "image decode" };
  }
  if (signal.aborted) return { type: "cancelled" };
  try {
    const decoded = await capability.decode(request, signal);
    if (signal.aborted) return { type: "cancelled" };
    const reason = validate_image(decoded);
    return reason === undefined
      ? { type: "ready", value: copy_image(decoded) }
      : { type: "failed", reason };
  } catch (error) {
    if (signal.aborted || is_abort_error(error)) return { type: "cancelled" };
    return {
      type: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function decode_audio(
  capability: AudioDecodeCapability | undefined,
  request: AudioDecodeRequest,
  signal: AbortSignal = new AbortController().signal,
): Promise<MediaDecodeResult<DecodedAudio>> {
  if (capability === undefined) {
    return { type: "capability_unavailable", capability: "audio decode" };
  }
  if (signal.aborted) return { type: "cancelled" };
  try {
    const decoded = await capability.decode(request, signal);
    if (signal.aborted) return { type: "cancelled" };
    const reason = validate_audio(decoded);
    return reason === undefined
      ? { type: "ready", value: copy_audio(decoded) }
      : { type: "failed", reason };
  } catch (error) {
    if (signal.aborted || is_abort_error(error)) return { type: "cancelled" };
    return {
      type: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function texture_mip_level_count(
  width: number,
  height: number,
  policy: TextureMipPolicy,
): number {
  if (!Number.isSafeInteger(width) || width <= 0) {
    throw new Error(
      `texture width ${JSON.stringify(width)} must be a positive safe integer`,
    );
  }
  if (!Number.isSafeInteger(height) || height <= 0) {
    throw new Error(
      `texture height ${
        JSON.stringify(height)
      } must be a positive safe integer`,
    );
  }
  return policy === "source-only"
    ? 1
    : Math.floor(Math.log2(Math.max(width, height))) + 1;
}

export function create_browser_image_decoder():
  | ImageDecodeCapability
  | undefined {
  if (
    typeof createImageBitmap !== "function" ||
    typeof OffscreenCanvas !== "function"
  ) {
    return undefined;
  }
  return {
    async decode(request, signal) {
      if (signal.aborted) {
        throw new DOMException("image decode cancelled", "AbortError");
      }
      const bitmap = await createImageBitmap(
        new Blob([new Uint8Array(request.bytes)], { type: request.mime_type }),
      );
      try {
        if (signal.aborted) {
          throw new DOMException("image decode cancelled", "AbortError");
        }
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (context === null) {
          throw new Error(
            `browser 2D canvas context is unavailable for ${bitmap.width}x${bitmap.height} image`,
          );
        }
        context.drawImage(bitmap, 0, 0);
        const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height);
        return {
          width: bitmap.width,
          height: bitmap.height,
          rgba8: new Uint8Array(pixels.data),
          color_space: request.color_space,
          mip_level_count: texture_mip_level_count(
            bitmap.width,
            bitmap.height,
            request.mip_policy,
          ),
        };
      } finally {
        bitmap.close();
      }
    },
  };
}

export function create_web_audio_decoder(
  context: BaseAudioContext,
): AudioDecodeCapability | undefined {
  if (
    !("decodeAudioData" in context) ||
    typeof context.decodeAudioData !== "function"
  ) {
    return undefined;
  }
  return {
    async decode(request, signal) {
      if (signal.aborted) {
        throw new DOMException("audio decode cancelled", "AbortError");
      }
      const bytes = new Uint8Array(request.bytes).buffer;
      const decoded = await context.decodeAudioData(bytes);
      if (signal.aborted) {
        throw new DOMException("audio decode cancelled", "AbortError");
      }
      const channels = Array.from(
        { length: decoded.numberOfChannels },
        (_, index) => new Float32Array(decoded.getChannelData(index)),
      );
      return {
        sample_rate: decoded.sampleRate,
        frame_count: decoded.length,
        channels,
      };
    },
  };
}

function validate_image(image: DecodedImage): string | undefined {
  if (!Number.isSafeInteger(image.width) || image.width <= 0) {
    return `decoded image width ${
      JSON.stringify(image.width)
    } must be a positive safe integer`;
  }
  if (!Number.isSafeInteger(image.height) || image.height <= 0) {
    return `decoded image height ${
      JSON.stringify(image.height)
    } must be a positive safe integer`;
  }
  const expected_bytes = image.width * image.height * 4;
  if (image.rgba8.length !== expected_bytes) {
    return `decoded ${image.width}x${image.height} image has ${image.rgba8.length} RGBA bytes; expected ${expected_bytes}`;
  }
  const expected_mips = texture_mip_level_count(
    image.width,
    image.height,
    image.mip_level_count === 1 ? "source-only" : "generate-complete-chain",
  );
  if (image.mip_level_count !== 1 && image.mip_level_count !== expected_mips) {
    return `decoded image has ${image.mip_level_count} mip levels; expected 1 or ${expected_mips}`;
  }
  return undefined;
}

function validate_audio(audio: DecodedAudio): string | undefined {
  if (!Number.isFinite(audio.sample_rate) || audio.sample_rate <= 0) {
    return `decoded audio sample rate ${
      JSON.stringify(audio.sample_rate)
    } must be positive and finite`;
  }
  if (!Number.isSafeInteger(audio.frame_count) || audio.frame_count < 0) {
    return `decoded audio frame count ${
      JSON.stringify(audio.frame_count)
    } must be a nonnegative safe integer`;
  }
  if (audio.channels.length === 0) {
    return "decoded audio must contain at least one channel";
  }
  const wrong_length = audio.channels.findIndex((channel) =>
    channel.length !== audio.frame_count
  );
  if (wrong_length >= 0) {
    return `decoded audio channel ${wrong_length} has ${
      audio.channels[wrong_length].length
    } frames; expected ${audio.frame_count}`;
  }
  return undefined;
}

function copy_image(image: DecodedImage): DecodedImage {
  return { ...image, rgba8: new Uint8Array(image.rgba8) };
}

function copy_audio(audio: DecodedAudio): DecodedAudio {
  return {
    ...audio,
    channels: audio.channels.map((channel) => new Float32Array(channel)),
  };
}

function is_abort_error(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
