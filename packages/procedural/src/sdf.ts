import { finite_number } from "@ink/math/scalar.ts";
import type { Vec3 } from "@ink/math/vector.ts";
import { vec3, vec3_length, vec3_subtract } from "@ink/math/vector.ts";

export interface SignedDistanceField {
  readonly sample: (position: Vec3) => number;
}

export function sphere_distance_field(
  center: Vec3,
  radius: number,
): SignedDistanceField {
  const parsed_radius = positive(radius, "sphere distance radius");
  return Object.freeze({
    sample(position: Vec3): number {
      return vec3_length(vec3_subtract(position, center)) - parsed_radius;
    },
  });
}

export function box_distance_field(
  center: Vec3,
  half_extent: Vec3,
): SignedDistanceField {
  if (half_extent.x <= 0 || half_extent.y <= 0 || half_extent.z <= 0) {
    throw new Error(
      `box distance half extent (${half_extent.x}, ${half_extent.y}, ${half_extent.z}) must be positive`,
    );
  }
  return Object.freeze({
    sample(position: Vec3): number {
      const local = vec3_subtract(position, center);
      const q = vec3(
        Math.abs(local.x) - half_extent.x,
        Math.abs(local.y) - half_extent.y,
        Math.abs(local.z) - half_extent.z,
      );
      const outside = vec3(
        Math.max(q.x, 0),
        Math.max(q.y, 0),
        Math.max(q.z, 0),
      );
      return vec3_length(outside) + Math.min(Math.max(q.x, q.y, q.z), 0);
    },
  });
}

export function union_distance_field(
  fields: readonly SignedDistanceField[],
): SignedDistanceField {
  require_fields(fields, "union");
  return Object.freeze({
    sample(position: Vec3): number {
      return Math.min(...fields.map((field) => field.sample(position)));
    },
  });
}

export function intersection_distance_field(
  fields: readonly SignedDistanceField[],
): SignedDistanceField {
  require_fields(fields, "intersection");
  return Object.freeze({
    sample(position: Vec3): number {
      return Math.max(...fields.map((field) => field.sample(position)));
    },
  });
}

export function subtract_distance_field(
  source: SignedDistanceField,
  removed: SignedDistanceField,
): SignedDistanceField {
  return Object.freeze({
    sample(position: Vec3): number {
      return Math.max(source.sample(position), -removed.sample(position));
    },
  });
}

export function smooth_union_distance_field(
  left: SignedDistanceField,
  right: SignedDistanceField,
  radius: number,
): SignedDistanceField {
  const smoothing = positive(radius, "smooth union radius");
  return Object.freeze({
    sample(position: Vec3): number {
      const left_distance = left.sample(position);
      const right_distance = right.sample(position);
      const amount = Math.max(
        0,
        Math.min(1, 0.5 + 0.5 * (right_distance - left_distance) / smoothing),
      );
      return right_distance + (left_distance - right_distance) * amount -
        smoothing * amount * (1 - amount);
    },
  });
}

export function offset_distance_field(
  field: SignedDistanceField,
  offset: number,
): SignedDistanceField {
  const distance = finite_number(offset, "distance field offset");
  return Object.freeze({
    sample(position: Vec3): number {
      return field.sample(position) - distance;
    },
  });
}

function require_fields(
  fields: readonly SignedDistanceField[],
  operation: string,
): void {
  if (fields.length === 0) {
    throw new Error(`${operation} distance field requires at least one field`);
  }
}

function positive(value: number, label: string): number {
  finite_number(value, label);
  if (value <= 0) throw new Error(`${label} ${value} must be positive`);
  return value;
}
