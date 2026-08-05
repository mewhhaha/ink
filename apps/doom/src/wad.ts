const wad_header_size = 12;
const wad_directory_entry_size = 16;
const wad_name_size = 8;

export type WadKind = "IWAD" | "PWAD";

export interface WadLump {
  readonly index: number;
  readonly name: string;
  readonly offset: number;
  readonly size: number;
}

export interface WadArchive {
  readonly kind: WadKind;
  readonly lumps: readonly WadLump[];
  find(name: string, occurrence?: number): WadLump | undefined;
  read(lump: WadLump | string): Uint8Array;
}

export function parse_wad(bytes: Uint8Array): WadArchive {
  if (bytes.byteLength < wad_header_size) {
    throw new Error("WAD is shorter than its 12-byte header");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = decode_ascii(bytes.subarray(0, 4));
  if (magic !== "IWAD" && magic !== "PWAD") {
    throw new Error(`Unsupported WAD type: ${JSON.stringify(magic)}`);
  }

  const lump_count = view.getInt32(4, true);
  const directory_offset = view.getInt32(8, true);
  if (lump_count < 0) {
    throw new Error(`WAD has a negative lump count: ${lump_count}`);
  }
  if (directory_offset < wad_header_size) {
    throw new Error(`WAD directory starts before the header: ${directory_offset}`);
  }

  const directory_size = lump_count * wad_directory_entry_size;
  const directory_end = directory_offset + directory_size;
  if (
    !Number.isSafeInteger(directory_size) ||
    directory_end < directory_offset ||
    directory_end > bytes.byteLength
  ) {
    throw new Error("WAD lump directory is outside the file");
  }

  const lumps: WadLump[] = [];
  for (let index = 0; index < lump_count; index += 1) {
    const entry_offset = directory_offset + index * wad_directory_entry_size;
    const offset = view.getInt32(entry_offset, true);
    const size = view.getInt32(entry_offset + 4, true);
    if (offset < 0 || size < 0 || offset + size > bytes.byteLength) {
      throw new Error(`WAD lump ${index} points outside the file`);
    }
    lumps.push({
      index,
      name: decode_lump_name(
        bytes.subarray(entry_offset + 8, entry_offset + 8 + wad_name_size),
      ),
      offset,
      size,
    });
  }

  return {
    kind: magic,
    lumps,
    find(name, occurrence = 0) {
      if (!Number.isInteger(occurrence) || occurrence < 0) return undefined;
      const wanted = normalize_lump_name(name);
      let found = 0;
      for (const lump of lumps) {
        if (lump.name !== wanted) continue;
        if (found === occurrence) return lump;
        found += 1;
      }
      return undefined;
    },
    read(lump) {
      const resolved = typeof lump === "string" ? this.find(lump) : lump;
      if (!resolved) {
        throw new Error(`WAD lump not found: ${String(lump)}`);
      }
      return bytes.slice(resolved.offset, resolved.offset + resolved.size);
    },
  };
}

function decode_lump_name(bytes: Uint8Array): string {
  return normalize_lump_name(decode_ascii(bytes));
}

function normalize_lump_name(name: string): string {
  return name.replaceAll("\0", "").trim().toUpperCase();
}

function decode_ascii(bytes: Uint8Array): string {
  return new TextDecoder("ascii").decode(bytes);
}
