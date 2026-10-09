export function hex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return [...view].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 over the concatenation of the parts, as lowercase hex. */
export async function sha256(
  ...parts: (Uint8Array | string)[]
): Promise<string> {
  const encoder = new TextEncoder();
  const bytes = parts.map((p) => typeof p === "string" ? encoder.encode(p) : p);
  let whole: Uint8Array;
  if (bytes.length === 1) whole = bytes[0];
  else {
    whole = new Uint8Array(bytes.reduce((n, b) => n + b.length + 8, 0));
    let at = 0;
    for (const b of bytes) {
      // Length-prefix every part so concatenations cannot collide.
      new DataView(whole.buffer).setBigUint64(at, BigInt(b.length), true);
      whole.set(b, at + 8);
      at += 8 + b.length;
    }
  }
  return hex(
    await crypto.subtle.digest("SHA-256", whole as unknown as BufferSource),
  );
}
