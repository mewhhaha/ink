/** Writing uncompressed KTX2 files: the quick preview of a texture, with a
 * complete precomputed mip chain. Basis-compressed files come straight from
 * the encoder. */
import {
  createDefaultContainer,
  KHR_DF_CHANNEL_RGBSDA_ALPHA,
  KHR_DF_CHANNEL_RGBSDA_BLUE,
  KHR_DF_CHANNEL_RGBSDA_GREEN,
  KHR_DF_CHANNEL_RGBSDA_RED,
  KHR_DF_MODEL_RGBSDA,
  KHR_DF_PRIMARIES_BT709,
  KHR_DF_TRANSFER_LINEAR,
  KHR_DF_TRANSFER_SRGB,
  read,
  VK_FORMAT_R8G8B8A8_SRGB,
  VK_FORMAT_R8G8B8A8_UNORM,
  write,
} from "ktx-parse";
import type { Rgba } from "./image.ts";

export function writeRawKtx2(levels: Rgba[], srgb: boolean): Uint8Array {
  const container = createDefaultContainer();
  container.vkFormat = srgb
    ? VK_FORMAT_R8G8B8A8_SRGB
    : VK_FORMAT_R8G8B8A8_UNORM;
  container.typeSize = 1;
  container.pixelWidth = levels[0].width;
  container.pixelHeight = levels[0].height;
  container.levelCount = levels.length;
  container.supercompressionScheme = 0;
  container.levels = levels.map((level) => ({
    levelData: new Uint8Array(level.data) as Uint8Array<ArrayBuffer>,
    uncompressedByteLength: level.data.length,
  }));
  const sample = (channel: number, offset: number) => ({
    bitOffset: offset,
    bitLength: 8,
    channelType: channel,
    samplePosition: [0, 0, 0, 0],
    sampleLower: 0,
    sampleUpper: 255,
  });
  container.dataFormatDescriptor = [{
    vendorId: 0,
    descriptorType: 0,
    versionNumber: 2,
    colorModel: KHR_DF_MODEL_RGBSDA,
    colorPrimaries: KHR_DF_PRIMARIES_BT709,
    transferFunction: srgb ? KHR_DF_TRANSFER_SRGB : KHR_DF_TRANSFER_LINEAR,
    flags: 0,
    texelBlockDimension: [0, 0, 0, 0],
    bytesPlane: [4, 0, 0, 0, 0, 0, 0, 0],
    samples: [
      sample(KHR_DF_CHANNEL_RGBSDA_RED, 0),
      sample(KHR_DF_CHANNEL_RGBSDA_GREEN, 8),
      sample(KHR_DF_CHANNEL_RGBSDA_BLUE, 16),
      sample(KHR_DF_CHANNEL_RGBSDA_ALPHA, 24),
    ],
  }];
  return write(container);
}

/** Header facts of a KTX2 file (no decoding). */
export function inspectKtx2(bytes: Uint8Array) {
  const c = read(bytes);
  return {
    vkFormat: c.vkFormat,
    width: c.pixelWidth,
    height: c.pixelHeight,
    levels: c.levelCount,
    supercompression: c.supercompressionScheme,
    color: c.dataFormatDescriptor[0]?.colorModel,
  };
}
