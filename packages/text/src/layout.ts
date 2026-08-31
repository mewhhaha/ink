import { parse_text_style, type TextStyle } from "./font.ts";

export interface TextMeasurement {
  readonly width: number;
  readonly ascent: number;
  readonly descent: number;
}

export interface TextMeasurer {
  measure(text: string, style: TextStyle): TextMeasurement;
}

export interface TextLayoutRequest {
  readonly text: string;
  readonly style: TextStyle;
  readonly maximum_width?: number;
  readonly maximum_lines?: number;
  readonly wrap?: "none" | "word" | "character";
  readonly align?: "start" | "center" | "end";
  readonly direction?: "ltr" | "rtl" | "auto";
}

export interface TextLine {
  readonly text: string;
  readonly width: number;
  readonly x: number;
  readonly baseline: number;
}

export interface TextLayout {
  readonly width: number;
  readonly height: number;
  readonly direction: "ltr" | "rtl";
  readonly overflowed: boolean;
  readonly lines: readonly TextLine[];
}

interface MeasuredLine {
  readonly text: string;
  readonly measurement: TextMeasurement;
}

export function layout_text(
  request: TextLayoutRequest,
  measurer: TextMeasurer,
): TextLayout {
  if (typeof request.text !== "string") {
    throw new Error(
      `text content ${JSON.stringify(request.text)} must be a string`,
    );
  }
  const style = parse_text_style(request.style);
  if (
    request.maximum_width !== undefined &&
    (!Number.isFinite(request.maximum_width) || request.maximum_width <= 0)
  ) {
    throw new Error(
      `text maximum width ${request.maximum_width} must be finite and positive`,
    );
  }
  if (
    request.maximum_lines !== undefined &&
    (!Number.isSafeInteger(request.maximum_lines) || request.maximum_lines <= 0)
  ) {
    throw new Error(
      `text maximum lines ${request.maximum_lines} must be a positive integer`,
    );
  }
  const wrap = request.wrap ?? "word";
  if (wrap !== "none" && wrap !== "word" && wrap !== "character") {
    throw new Error(`text wrap ${JSON.stringify(wrap)} is unsupported`);
  }
  const align = request.align ?? "start";
  if (align !== "start" && align !== "center" && align !== "end") {
    throw new Error(`text alignment ${JSON.stringify(align)} is unsupported`);
  }
  if (
    request.direction !== undefined && request.direction !== "auto" &&
    request.direction !== "ltr" && request.direction !== "rtl"
  ) {
    throw new Error(
      `text direction ${JSON.stringify(request.direction)} is unsupported`,
    );
  }
  const measured: MeasuredLine[] = [];
  const maximum_width = request.maximum_width;
  for (const paragraph of request.text.replaceAll("\r\n", "\n").split("\n")) {
    const lines = wrap_paragraph(
      paragraph,
      style,
      maximum_width,
      wrap,
      measurer,
    );
    measured.push(...lines);
  }
  if (measured.length === 0) measured.push(measure_line("", style, measurer));
  const maximum_lines = request.maximum_lines ?? measured.length;
  const visible = measured.slice(0, maximum_lines);
  const content_width = Math.max(
    0,
    ...visible.map((line) => line.measurement.width),
  );
  const width = maximum_width ?? content_width;
  const line_height = style.line_height ?? Math.max(
    style.size,
    ...visible.map((line) =>
      line.measurement.ascent + line.measurement.descent
    ),
  );
  const direction =
    request.direction === undefined || request.direction === "auto"
      ? infer_direction(request.text)
      : request.direction;
  const lines = visible.map((line, index) => {
    const baseline = index * line_height + line.measurement.ascent;
    if (!Number.isFinite(baseline)) {
      throw new Error(
        `text line ${index} baseline ${baseline} must be finite`,
      );
    }
    return Object.freeze({
      text: line.text,
      width: line.measurement.width,
      x: line_x(width, line.measurement.width, align, direction),
      baseline,
    });
  });
  const height = line_height * lines.length;
  if (!Number.isFinite(height)) {
    throw new Error(`text layout height ${height} must be finite`);
  }
  return Object.freeze({
    width,
    height,
    direction,
    overflowed: measured.length > visible.length ||
      (maximum_width !== undefined &&
        visible.some((line) => line.measurement.width > maximum_width)),
    lines: Object.freeze(lines),
  });
}

function wrap_paragraph(
  paragraph: string,
  style: TextStyle,
  maximum_width: number | undefined,
  wrap: "none" | "word" | "character",
  measurer: TextMeasurer,
): readonly MeasuredLine[] {
  if (maximum_width === undefined || wrap === "none") {
    return [measure_line(paragraph, style, measurer)];
  }
  const segments = wrap === "character"
    ? Array.from(paragraph)
    : paragraph.split(/(\s+)/).filter((segment) => segment.length > 0);
  if (segments.length === 0) return [measure_line("", style, measurer)];
  const lines: MeasuredLine[] = [];
  let current = "";
  for (const segment of segments) {
    if (current.length === 0) {
      const first = segment.trimStart();
      if (
        wrap === "word" &&
        measure_line(first, style, measurer).measurement.width > maximum_width
      ) {
        const split = wrap_paragraph(
          first,
          style,
          maximum_width,
          "character",
          measurer,
        );
        lines.push(...split.slice(0, -1));
        current = split.at(-1)?.text ?? "";
      } else {
        current = segment;
      }
      continue;
    }
    const candidate = current + segment;
    const candidate_line = measure_line(candidate.trimEnd(), style, measurer);
    if (candidate_line.measurement.width <= maximum_width) {
      current = candidate;
      continue;
    }
    lines.push(measure_line(current.trimEnd(), style, measurer));
    current = segment.trimStart();
    if (
      wrap === "word" &&
      measure_line(current, style, measurer).measurement.width > maximum_width
    ) {
      const split = wrap_paragraph(
        current,
        style,
        maximum_width,
        "character",
        measurer,
      );
      lines.push(...split.slice(0, -1));
      current = split.at(-1)?.text ?? "";
    }
  }
  lines.push(measure_line(current.trimEnd(), style, measurer));
  return lines;
}

function measure_line(
  text: string,
  style: TextStyle,
  measurer: TextMeasurer,
): MeasuredLine {
  const measurement = measurer.measure(text, style);
  if (typeof measurement !== "object" || measurement === null) {
    throw new Error(
      `text measurement for ${JSON.stringify(text)} must be an object`,
    );
  }
  for (
    const [name, value] of [
      ["width", measurement.width],
      ["ascent", measurement.ascent],
      ["descent", measurement.descent],
    ] as const
  ) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(
        `text measurement ${name} ${value} for ${
          JSON.stringify(text)
        } must be finite and nonnegative`,
      );
    }
  }
  return { text, measurement };
}

function line_x(
  container_width: number,
  line_width: number,
  align: "start" | "center" | "end",
  direction: "ltr" | "rtl",
): number {
  if (align === "center") return (container_width - line_width) / 2;
  const physical_end = align === "end"
    ? direction === "ltr"
    : direction === "rtl";
  return physical_end ? container_width - line_width : 0;
}

function infer_direction(text: string): "ltr" | "rtl" {
  for (const character of text) {
    if (/\p{Script=Arabic}|\p{Script=Hebrew}/u.test(character)) return "rtl";
    if (/\p{Letter}/u.test(character)) return "ltr";
  }
  return "ltr";
}
