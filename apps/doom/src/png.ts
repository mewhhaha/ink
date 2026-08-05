const png_signature = new Uint8Array([
  137,
  80,
  78,
  71,
  13,
  10,
  26,
  10,
]);

export async function encode_png_rgba(
  width: number,
  height: number,
  rgba: Uint8Array,
): Promise<Uint8Array> {
  if (rgba.length !== width * height * 4) {
    throw new Error("RGBA buffer does not match PNG dimensions");
  }

  const scanlines = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const scanline_start = y * (width * 4 + 1);
    scanlines[scanline_start] = 0;
    scanlines.set(
      rgba.subarray(y * width * 4, (y + 1) * width * 4),
      scanline_start + 1,
    );
  }

  const compressed = new Uint8Array(
    await new Response(
      new Blob([scanlines]).stream().pipeThrough(
        new CompressionStream("deflate"),
      ),
    ).arrayBuffer(),
  );

  const header = new Uint8Array(13);
  const header_view = new DataView(header.buffer);
  header_view.setUint32(0, width, false);
  header_view.setUint32(4, height, false);
  header[8] = 8;
  header[9] = 6;

  return concat_bytes(
    png_signature,
    png_chunk("IHDR", header),
    png_chunk("IDAT", compressed),
    png_chunk("IEND", new Uint8Array()),
  );
}

function png_chunk(type: string, data: Uint8Array): Uint8Array {
  const type_bytes = new TextEncoder().encode(type);
  const body = concat_bytes(type_bytes, data);
  const chunk = new Uint8Array(body.length + 8);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length, false);
  chunk.set(body, 4);
  view.setUint32(body.length + 4, crc32(body), false);
  return chunk;
}

function concat_bytes(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
