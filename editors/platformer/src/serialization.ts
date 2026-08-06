import type { PlatformerProject } from "./model.ts";

export function serialize_platformer_project(
  project: PlatformerProject,
): string {
  return JSON.stringify(canonical(project), null, 2) + "\n";
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonical(nested)]),
  );
}
