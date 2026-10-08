/** A deterministic, nonzero 24-bit symbol for text crossing the F32 boundary.
 * The host retains the string. The guest can compare names without strings. */
export function textId(text: string): number {
  if (!text) return 0;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (((hash >>> 24) ^ hash) & 0xffffff) || 1;
}

/** Reject ambiguous symbols instead of silently aliasing different names. */
export function validateTextIds(texts: Iterable<string>) {
  const seen = new Map<number, string>();
  for (const text of texts) {
    const id = textId(text);
    const previous = seen.get(id);
    if (previous !== undefined && previous !== text) {
      throw new Error(
        `name id collision between ${JSON.stringify(previous)} and ${
          JSON.stringify(text)
        }`,
      );
    }
    seen.set(id, text);
  }
}
