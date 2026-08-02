const encoder = new TextEncoder();

export async function digest_text(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function digest_bytes(value: Uint8Array): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(value).buffer,
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function canonical_json(value: unknown): string {
  return JSON.stringify(sort_json_value(value));
}

function sort_json_value(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort_json_value);
  if (value === null || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sort_json_value(entry)]),
  );
}
