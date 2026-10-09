/**
 * Byte ranges of a file, packed into one request body: for each range a
 * little-endian `u32` offset, a `u32` length and the bytes. The dev client
 * sends them to `PATCH /__ink/assets-write/<path>`; the server decodes and
 * writes them in order. Browser-safe.
 */
export interface AssetSegment {
  /** Where the bytes go in the file. */
  offset: number;
  bytes: Uint8Array;
}

const HEADER = 8;

export function encodeSegments(segments: readonly AssetSegment[]): Uint8Array {
  let size = 0;
  for (const s of segments) size += HEADER + s.bytes.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const s of segments) {
    view.setUint32(at, s.offset, true);
    view.setUint32(at + 4, s.bytes.length, true);
    out.set(s.bytes, at + HEADER);
    at += HEADER + s.bytes.length;
  }
  return out;
}

/** Throws on a body that is cut short or has bytes left over. */
export function decodeSegments(body: Uint8Array): AssetSegment[] {
  const out: AssetSegment[] = [];
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let at = 0;
  while (at < body.length) {
    if (at + HEADER > body.length) throw new Error("segment header is cut off");
    const offset = view.getUint32(at, true);
    const length = view.getUint32(at + 4, true);
    at += HEADER;
    if (at + length > body.length) throw new Error("segment is cut off");
    out.push({ offset, bytes: body.subarray(at, at + length) });
    at += length;
  }
  return out;
}
