import { finite_number } from "./scalar.ts";
import { type Vec2, vec2, type Vec3, vec3, type Vec4, vec4 } from "./vector.ts";

declare const fixed_point_format_brand: unique symbol;

export interface FixedPointFormat {
  readonly scale: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly [fixed_point_format_brand]: true;
}

export function fixed_point_format(
  scale: number,
  minimum: number,
  maximum: number,
): FixedPointFormat {
  if (!Number.isSafeInteger(scale) || scale <= 0) {
    throw new Error(
      `fixed-point scale must be a positive safe integer, received ${scale}`,
    );
  }
  if (
    !Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) ||
    minimum >= maximum
  ) {
    throw new Error(
      `fixed-point integer range [${minimum}, ${maximum}] must contain ordered safe integers`,
    );
  }
  return Object.freeze({ scale, minimum, maximum }) as FixedPointFormat;
}

export const guest_fixed_point_format = fixed_point_format(
  1_000_000,
  -2_147_483_648,
  2_147_483_647,
);

export function decode_fixed_point(
  guest_value: number,
  format = guest_fixed_point_format,
  label = "guest fixed-point value",
): number {
  if (!Number.isSafeInteger(guest_value)) {
    throw new Error(
      `${label} must be a safe integer, received ${String(guest_value)}`,
    );
  }
  if (guest_value < format.minimum || guest_value > format.maximum) {
    throw new Error(
      `${label} ${guest_value} is outside [${format.minimum}, ${format.maximum}]`,
    );
  }
  return guest_value / format.scale;
}

export function encode_fixed_point(
  host_value: number,
  format = guest_fixed_point_format,
  label = "host fixed-point value",
): number {
  finite_number(host_value, label);
  const guest_value = Math.round(host_value * format.scale);
  if (
    !Number.isSafeInteger(guest_value) || guest_value < format.minimum ||
    guest_value > format.maximum
  ) {
    throw new Error(
      `${label} ${host_value} encodes as ${
        String(guest_value)
      }, outside [${format.minimum}, ${format.maximum}]`,
    );
  }
  return guest_value;
}

export function decode_fixed_vec2(
  values: readonly [number, number],
  format = guest_fixed_point_format,
): Vec2 {
  return vec2(
    decode_fixed_point(values[0], format, "guest vec2.x"),
    decode_fixed_point(values[1], format, "guest vec2.y"),
  );
}

export function decode_fixed_vec3(
  values: readonly [number, number, number],
  format = guest_fixed_point_format,
): Vec3 {
  return vec3(
    decode_fixed_point(values[0], format, "guest vec3.x"),
    decode_fixed_point(values[1], format, "guest vec3.y"),
    decode_fixed_point(values[2], format, "guest vec3.z"),
  );
}

export function decode_fixed_vec4(
  values: readonly [number, number, number, number],
  format = guest_fixed_point_format,
): Vec4 {
  return vec4(
    decode_fixed_point(values[0], format, "guest vec4.x"),
    decode_fixed_point(values[1], format, "guest vec4.y"),
    decode_fixed_point(values[2], format, "guest vec4.z"),
    decode_fixed_point(values[3], format, "guest vec4.w"),
  );
}

export function encode_fixed_vec2(
  value: Vec2,
  format = guest_fixed_point_format,
): readonly [number, number] {
  return Object.freeze([
    encode_fixed_point(value.x, format, "host vec2.x"),
    encode_fixed_point(value.y, format, "host vec2.y"),
  ]);
}

export function encode_fixed_vec3(
  value: Vec3,
  format = guest_fixed_point_format,
): readonly [number, number, number] {
  return Object.freeze([
    encode_fixed_point(value.x, format, "host vec3.x"),
    encode_fixed_point(value.y, format, "host vec3.y"),
    encode_fixed_point(value.z, format, "host vec3.z"),
  ]);
}

export function encode_fixed_vec4(
  value: Vec4,
  format = guest_fixed_point_format,
): readonly [number, number, number, number] {
  return Object.freeze([
    encode_fixed_point(value.x, format, "host vec4.x"),
    encode_fixed_point(value.y, format, "host vec4.y"),
    encode_fixed_point(value.z, format, "host vec4.z"),
    encode_fixed_point(value.w, format, "host vec4.w"),
  ]);
}
