import type { AssetRef } from "@ink/assets/identity.ts";

const generic_font_families = new Set([
  "cursive",
  "fantasy",
  "monospace",
  "sans-serif",
  "serif",
  "system-ui",
  "ui-monospace",
  "ui-rounded",
  "ui-sans-serif",
  "ui-serif",
]);

export interface FontFaceDefinition {
  readonly asset: AssetRef<"font">;
  readonly weight: number;
  readonly style: "normal" | "italic";
}

export interface FontFamilySource {
  readonly family: string;
  readonly faces: readonly FontFaceDefinition[];
  readonly fallbacks?: readonly string[];
}

export interface FontFamily {
  readonly family: string;
  readonly faces: readonly FontFaceDefinition[];
  readonly fallbacks: readonly string[];
}

export interface TextStyle {
  readonly font: FontFamily;
  readonly size: number;
  readonly weight: number;
  readonly style: "normal" | "italic";
  readonly letter_spacing?: number;
  readonly line_height?: number;
}

export function create_font_family(source: FontFamilySource): FontFamily {
  const family = parse_family(source.family, "font family");
  if (source.faces.length === 0) {
    throw new Error(
      `font family ${JSON.stringify(family)} requires at least one face`,
    );
  }
  const combinations = new Set<string>();
  const faces = source.faces.map((face) => {
    if (face.asset.kind !== "font") {
      throw new Error(
        `font face ${face.asset.id} kind ${face.asset.kind} must be font`,
      );
    }
    if (face.style !== "normal" && face.style !== "italic") {
      throw new Error(
        `font face ${face.asset.id} style ${
          JSON.stringify(face.style)
        } is unsupported`,
      );
    }
    const weight = parse_weight(
      face.weight,
      `font face ${face.asset.id} weight`,
    );
    const combination = `${weight}:${face.style}`;
    if (combinations.has(combination)) {
      throw new Error(
        `font family ${
          JSON.stringify(family)
        } repeats ${face.style} weight ${weight}`,
      );
    }
    combinations.add(combination);
    return Object.freeze({
      asset: Object.freeze({ ...face.asset }),
      weight,
      style: face.style,
    });
  }).sort((left, right) =>
    left.weight - right.weight || left.style.localeCompare(right.style)
  );
  const fallbacks = (source.fallbacks ?? []).map((fallback, index) =>
    parse_family(
      fallback,
      `font family ${JSON.stringify(family)} fallback ${index}`,
    )
  );
  if (new Set([family, ...fallbacks]).size !== fallbacks.length + 1) {
    throw new Error(
      `font family ${JSON.stringify(family)} contains a duplicate fallback`,
    );
  }
  return Object.freeze({
    family,
    faces: Object.freeze(faces),
    fallbacks: Object.freeze(fallbacks),
  });
}

export function parse_text_style(style: TextStyle): TextStyle {
  const font = create_font_family(style.font);
  if (!Number.isFinite(style.size) || style.size <= 0) {
    throw new Error(`text size ${style.size} must be finite and positive`);
  }
  const weight = parse_weight(style.weight, "text weight");
  if (style.style !== "normal" && style.style !== "italic") {
    throw new Error(`text style ${JSON.stringify(style.style)} is unsupported`);
  }
  if (
    style.letter_spacing !== undefined && !Number.isFinite(style.letter_spacing)
  ) {
    throw new Error(
      `text letter spacing ${style.letter_spacing} must be finite`,
    );
  }
  if (
    style.line_height !== undefined &&
    (!Number.isFinite(style.line_height) || style.line_height <= 0)
  ) {
    throw new Error(
      `text line height ${style.line_height} must be finite and positive`,
    );
  }
  return Object.freeze({
    font,
    size: style.size,
    weight,
    style: style.style,
    ...(style.letter_spacing === undefined
      ? {}
      : { letter_spacing: style.letter_spacing }),
    ...(style.line_height === undefined
      ? {}
      : { line_height: style.line_height }),
  });
}

export function css_font(style: TextStyle): string {
  const families = [style.font.family, ...style.font.fallbacks]
    .map((family) =>
      generic_font_families.has(family) ? family : JSON.stringify(family)
    )
    .join(", ");
  return `${style.style} ${style.weight} ${style.size}px ${families}`;
}

function parse_family(value: string, label: string): string {
  const parsed = value.trim();
  if (parsed.length === 0) {
    throw new Error(`${label} ${JSON.stringify(value)} cannot be empty`);
  }
  return parsed;
}

function parse_weight(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000) {
    throw new Error(`${label} ${value} must be an integer within 1..1000`);
  }
  return value;
}
