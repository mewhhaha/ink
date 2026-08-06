const text_encoder = new TextEncoder();

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export async function digest_bytes(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value.slice().buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function digest_text(value: string): Promise<string> {
  return await digest_bytes(text_encoder.encode(value));
}

export function canonical_json(value: unknown): string {
  return JSON.stringify(sort_json_value(value));
}

export async function digest_json(value: JsonValue): Promise<string> {
  return await digest_bytes(text_encoder.encode(canonical_json(value)));
}

function sort_json_value(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort_json_value);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sort_json_value(entry)]),
  );
}
