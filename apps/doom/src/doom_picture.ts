export interface DoomPicture {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

export function decode_doom_picture(bytes: Uint8Array): DoomPicture {
  if (bytes.byteLength < 8) {
    throw new Error("Doom picture is shorter than its header");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint16(0, true);
  const height = view.getUint16(2, true);
  if (width === 0 || height === 0) {
    throw new Error("Doom picture has an empty size");
  }

  const column_table_end = 8 + width * 4;
  if (column_table_end > bytes.byteLength) {
    throw new Error("Doom picture column table is outside the lump");
  }

  const pixels = new Uint8Array(width * height);
  pixels.fill(255);
  for (let column = 0; column < width; column += 1) {
    const column_offset = view.getUint32(8 + column * 4, true);
    if (column_offset >= bytes.byteLength) {
      throw new Error(`Doom picture column ${column} is outside the lump`);
    }
    decode_column(bytes, column_offset, column, height, pixels, width);
  }

  return { width, height, pixels };
}

export function doom_picture_rgba(
  picture: DoomPicture,
  palette: Uint8Array,
): Uint8Array {
  if (palette.byteLength < 768) {
    throw new Error("Doom palette is shorter than 256 RGB colors");
  }
  const rgba = new Uint8Array(picture.width * picture.height * 4);
  for (let index = 0; index < picture.pixels.length; index += 1) {
    const palette_index = picture.pixels[index];
    const destination = index * 4;
    if (palette_index === 255) {
      rgba[destination + 3] = 0;
      continue;
    }
    const source = palette_index * 3;
    rgba[destination] = palette[source];
    rgba[destination + 1] = palette[source + 1];
    rgba[destination + 2] = palette[source + 2];
    rgba[destination + 3] = 255;
  }
  return rgba;
}

function decode_column(
  bytes: Uint8Array,
  offset: number,
  column: number,
  height: number,
  pixels: Uint8Array,
  width: number,
): void {
  let cursor = offset;
  while (true) {
    if (cursor >= bytes.byteLength) {
      throw new Error(`Doom picture column ${column} has no terminator`);
    }
    const top_delta = bytes[cursor];
    if (top_delta === 255) return;
    if (cursor + 3 > bytes.byteLength) {
      throw new Error(`Doom picture column ${column} has a truncated post`);
    }
    const length = bytes[cursor + 1];
    const pixels_start = cursor + 3;
    const pixels_end = pixels_start + length;
    if (pixels_end >= bytes.byteLength) {
      throw new Error(`Doom picture column ${column} has truncated pixels`);
    }
    for (let row = 0; row < length; row += 1) {
      const y = top_delta + row;
      if (y < height) pixels[y * width + column] = bytes[pixels_start + row];
    }
    cursor = pixels_end + 1;
  }
}
