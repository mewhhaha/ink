import { css_font, type TextStyle } from "./font.ts";
import type { TextMeasurer } from "./layout.ts";

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
