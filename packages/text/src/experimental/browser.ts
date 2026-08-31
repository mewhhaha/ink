import type { TextStyle } from "../font.ts";
import type { TextMeasurer } from "../layout.ts";

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

export function css_font(style: TextStyle): string {
  const families = [style.font.family, ...style.font.fallbacks]
    .map((family) =>
      generic_font_families.has(family) ? family : JSON.stringify(family)
    )
    .join(", ");
  return `${style.style} ${style.weight} ${style.size}px ${families}`;
}

export function canvas_text_measurer(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
): TextMeasurer {
  return {
    measure(text: string, style: TextStyle) {
      context.font = css_font(style);
      context.fontKerning = "normal";
      context.letterSpacing = `${style.letter_spacing ?? 0}px`;
      const measured = context.measureText(text);
      return {
        width: measured.width,
        ascent: measured.actualBoundingBoxAscent,
        descent: measured.actualBoundingBoxDescent,
      };
    },
  };
}
