import { content_digest, type ContentDigest } from "./identity.ts";

export interface DigestMismatch {
  readonly type: "digest_mismatch";
  readonly expected: ContentDigest;
  readonly actual: ContentDigest;
  readonly byte_size: number;
}

export async function digest_bytes(bytes: Uint8Array): Promise<ContentDigest> {
  const digest_input = new Uint8Array(bytes);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", digest_input.buffer),
  );
  const hexadecimal = Array.from(
    digest,
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
  return content_digest(`sha256:${hexadecimal}`);
}

export async function verify_digest(
  bytes: Uint8Array,
  expected: ContentDigest,
): Promise<{ readonly type: "verified" } | DigestMismatch> {
  const actual = await digest_bytes(bytes);
  if (actual === expected) return { type: "verified" };
  return { type: "digest_mismatch", expected, actual, byte_size: bytes.length };
}
