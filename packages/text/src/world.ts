import { attachment_key } from "@ink/scene/identity.ts";
import { parse_text_style } from "./font.ts";
import type { TextLayoutRequest } from "./layout.ts";

export interface WorldText {
  readonly layout: TextLayoutRequest;
  readonly pixels_per_metre: number;
  readonly facing: "fixed" | "billboard" | "billboard_y";
  readonly depth: "test" | "overlay";
}

export const world_text_attachment = attachment_key<WorldText>(
  "ink.text",
  "world",
);

export function world_text(source: WorldText): WorldText {
  if (
    !Number.isFinite(source.pixels_per_metre) || source.pixels_per_metre <= 0
  ) {
    throw new Error(
      `world text pixels per metre ${source.pixels_per_metre} must be finite and positive`,
    );
  }
  if (
    typeof source.layout.text !== "string" || source.layout.text.length === 0
  ) {
    throw new Error("world text content cannot be empty");
  }
  if (
    source.facing !== "fixed" && source.facing !== "billboard" &&
    source.facing !== "billboard_y"
  ) {
    throw new Error(
      `world text facing ${JSON.stringify(source.facing)} is unsupported`,
    );
  }
  if (source.depth !== "test" && source.depth !== "overlay") {
    throw new Error(
      `world text depth ${JSON.stringify(source.depth)} is unsupported`,
    );
  }
  if (
    source.layout.wrap !== undefined && source.layout.wrap !== "none" &&
    source.layout.wrap !== "word" && source.layout.wrap !== "character"
  ) {
    throw new Error(
      `world text wrap ${JSON.stringify(source.layout.wrap)} is unsupported`,
    );
  }
  if (
    source.layout.align !== undefined && source.layout.align !== "start" &&
    source.layout.align !== "center" && source.layout.align !== "end"
  ) {
    throw new Error(
      `world text alignment ${
        JSON.stringify(source.layout.align)
      } is unsupported`,
    );
  }
  if (
    source.layout.direction !== undefined &&
    source.layout.direction !== "auto" && source.layout.direction !== "ltr" &&
    source.layout.direction !== "rtl"
  ) {
    throw new Error(
      `world text direction ${
        JSON.stringify(source.layout.direction)
      } is unsupported`,
    );
  }
  if (
    source.layout.maximum_width !== undefined &&
    (!Number.isFinite(source.layout.maximum_width) ||
      source.layout.maximum_width <= 0)
  ) {
    throw new Error(
      `world text maximum width ${source.layout.maximum_width} must be finite and positive`,
    );
  }
  if (
    source.layout.maximum_lines !== undefined &&
    (!Number.isSafeInteger(source.layout.maximum_lines) ||
      source.layout.maximum_lines <= 0)
  ) {
    throw new Error(
      `world text maximum lines ${source.layout.maximum_lines} must be a positive integer`,
    );
  }
  return Object.freeze({
    pixels_per_metre: source.pixels_per_metre,
    facing: source.facing,
    depth: source.depth,
    layout: Object.freeze({
      ...source.layout,
      style: parse_text_style(source.layout.style),
    }),
  });
}
