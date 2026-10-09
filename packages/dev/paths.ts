/** Pure helpers: path safety and ids. */
import {
  isAbsolute,
  join,
  normalize,
  resolve,
  SEPARATOR as sep,
} from "@std/path";

export class PathError extends Error {
  override name = "PathError";
}

/**
 * Resolve a URL-ish relative path inside `root`. Rejects traversal (`..`),
 * absolute paths, backslashes, NUL bytes and empty names.
 */
export function resolveInside(root: string, relative: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(relative);
  } catch {
    throw new PathError(`bad path encoding: ${relative}`);
  }
  if (decoded === "" || decoded.includes("\0") || decoded.includes("\\")) {
    throw new PathError(`unsafe path: ${JSON.stringify(relative)}`);
  }
  if (decoded.startsWith("/") || isAbsolute(decoded)) {
    throw new PathError(`absolute path not allowed: ${decoded}`);
  }
  const parts = decoded.split("/");
  if (parts.some((p) => p === ".." || p === "" || p === ".")) {
    throw new PathError(`unsafe path: ${decoded}`);
  }
  const base = resolve(root);
  const full = normalize(join(base, ...parts));
  if (!full.startsWith(base + sep)) {
    throw new PathError(`path escapes its directory: ${decoded}`);
  }
  return full;
}

const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** A single path segment: scene names, hand-off and capture ids. */
export function checkName(name: string): string {
  if (!NAME.test(name) || name.includes("..")) {
    throw new PathError(`invalid name: ${JSON.stringify(name)}`);
  }
  return name;
}

/** Sortable id such as `2026-10-08T12-03-11-abc`. */
export function makeId(now = new Date(), random = Math.random): string {
  const stamp = now.toISOString().slice(0, 19).replaceAll(":", "-");
  const suffix = Array.from(
    { length: 3 },
    () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(random() * 36)],
  ).join("");
  return `${stamp}-${suffix}`;
}

/** Deterministic pretty JSON: 2 spaces, short primitive arrays inline. */
export function stableJson(value: unknown): string {
  return write(value, "") + "\n";
}

function write(value: unknown, indent: string): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every((v) => v === null || typeof v !== "object")) {
      const inline = `[${value.map((v) => JSON.stringify(v)).join(", ")}]`;
      if (inline.length + indent.length <= 80) return inline;
      // Long runs of numbers (tile maps) wrap like prose instead of
      // taking a line each.
      const inner = indent + "  ";
      const rows: string[] = [];
      let row = "";
      for (const v of value) {
        const item = JSON.stringify(v);
        if (row && inner.length + row.length + item.length + 2 > 100) {
          rows.push(row);
          row = "";
        }
        row += (row ? " " : "") + item + ",";
      }
      rows.push(row);
      return `[\n${
        rows.map((r) => inner + r).join("\n").replace(/,$/, "")
      }\n${indent}]`;
    }
    const inner = indent + "  ";
    return `[\n${
      value.map((v) => inner + write(v, inner)).join(",\n")
    }\n${indent}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return "{}";
    const inner = indent + "  ";
    return `{\n${
      entries.map(([k, v]) =>
        `${inner}${JSON.stringify(k)}: ${write(v, inner)}`
      )
        .join(",\n")
    }\n${indent}}`;
  }
  return JSON.stringify(value) ?? "null";
}
