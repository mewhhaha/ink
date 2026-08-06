declare const linear_rgb_brand: unique symbol;
declare const linear_rgba_brand: unique symbol;
declare const srgb_rgb_brand: unique symbol;
declare const srgb_rgba_brand: unique symbol;

export interface LinearRgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly [linear_rgb_brand]: true;
}

export interface LinearRgba extends LinearRgb {
  readonly a: number;
  readonly [linear_rgba_brand]: true;
}

export interface SrgbRgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly [srgb_rgb_brand]: true;
}

export interface SrgbRgba extends SrgbRgb {
  readonly a: number;
  readonly [srgb_rgba_brand]: true;
}

function finite_nonnegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} ${String(value)} must be finite and nonnegative`);
  }
  return value;
}

function unit(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} ${String(value)} must be within [0, 1]`);
  }
  return value;
}

export function linear_rgb(r: number, g: number, b: number): LinearRgb {
  return Object.freeze({
    r: finite_nonnegative(r, "linear red"),
    g: finite_nonnegative(g, "linear green"),
    b: finite_nonnegative(b, "linear blue"),
  }) as LinearRgb;
}

export function linear_rgba(
  r: number,
  g: number,
  b: number,
  a: number,
): LinearRgba {
  return Object.freeze({
    ...linear_rgb(r, g, b),
    a: unit(a, "linear alpha"),
  }) as LinearRgba;
}

export function srgb_rgb(r: number, g: number, b: number): SrgbRgb {
  return Object.freeze({
    r: unit(r, "sRGB red"),
    g: unit(g, "sRGB green"),
    b: unit(b, "sRGB blue"),
  }) as SrgbRgb;
}

export function srgb_rgba(
  r: number,
  g: number,
  b: number,
  a: number,
): SrgbRgba {
  return Object.freeze({
    ...srgb_rgb(r, g, b),
    a: unit(a, "sRGB alpha"),
  }) as SrgbRgba;
}

function channel_to_linear(channel: number): number {
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}

function channel_to_srgb(channel: number): number {
  return channel <= 0.0031308
    ? channel * 12.92
    : 1.055 * channel ** (1 / 2.4) - 0.055;
}

export function srgb_to_linear(color: SrgbRgba): LinearRgba;
export function srgb_to_linear(color: SrgbRgb): LinearRgb;
export function srgb_to_linear(
  color: SrgbRgb | SrgbRgba,
): LinearRgb | LinearRgba {
  const converted = linear_rgb(
    channel_to_linear(color.r),
    channel_to_linear(color.g),
    channel_to_linear(color.b),
  );
  return "a" in color
    ? linear_rgba(converted.r, converted.g, converted.b, color.a)
    : converted;
}

export function linear_to_srgb(color: LinearRgba): SrgbRgba;
export function linear_to_srgb(color: LinearRgb): SrgbRgb;
export function linear_to_srgb(
  color: LinearRgb | LinearRgba,
): SrgbRgb | SrgbRgba {
  if (color.r > 1 || color.g > 1 || color.b > 1) {
    throw new Error(
      `linear color (${color.r}, ${color.g}, ${color.b}) cannot be encoded as bounded sRGB`,
    );
  }
  const converted = srgb_rgb(
    channel_to_srgb(color.r),
    channel_to_srgb(color.g),
    channel_to_srgb(color.b),
  );
  return "a" in color
    ? srgb_rgba(converted.r, converted.g, converted.b, color.a)
    : converted;
}
