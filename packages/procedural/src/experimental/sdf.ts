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
  const parsed_center = vec3(center.x, center.y, center.z);
  const parsed_radius = positive(radius, "sphere distance radius");
  return Object.freeze({
    sample(position: Vec3): number {
      return vec3_length(vec3_subtract(position, parsed_center)) -
        parsed_radius;
    },
  });
}

export function box_distance_field(
  center: Vec3,
  half_extent: Vec3,
): SignedDistanceField {
  if (
    ![half_extent.x, half_extent.y, half_extent.z].every(Number.isFinite) ||
    half_extent.x <= 0 || half_extent.y <= 0 || half_extent.z <= 0
  ) {
    throw new Error(
      `box distance half extent (${half_extent.x}, ${half_extent.y}, ${half_extent.z}) must be positive`,
    );
  }
  const parsed_center = vec3(center.x, center.y, center.z);
  const parsed_half_extent = vec3(
    half_extent.x,
    half_extent.y,
    half_extent.z,
  );
  return Object.freeze({
    sample(position: Vec3): number {
      const local = vec3_subtract(position, parsed_center);
      const q = vec3(
        Math.abs(local.x) - parsed_half_extent.x,
        Math.abs(local.y) - parsed_half_extent.y,
        Math.abs(local.z) - parsed_half_extent.z,
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
  const sources = Object.freeze([...fields]);
  return Object.freeze({
    sample(position: Vec3): number {
      let distance = Number.POSITIVE_INFINITY;
      for (const [index, field] of sources.entries()) {
        distance = Math.min(
          distance,
          sample_field(field, position, `union field ${index}`),
        );
      }
      return distance;
    },
  });
}

export function intersection_distance_field(
  fields: readonly SignedDistanceField[],
): SignedDistanceField {
  require_fields(fields, "intersection");
  const sources = Object.freeze([...fields]);
  return Object.freeze({
    sample(position: Vec3): number {
      let distance = Number.NEGATIVE_INFINITY;
      for (const [index, field] of sources.entries()) {
        distance = Math.max(
          distance,
          sample_field(field, position, `intersection field ${index}`),
        );
      }
      return distance;
    },
  });
}

export function subtract_distance_field(
  source: SignedDistanceField,
  removed: SignedDistanceField,
): SignedDistanceField {
  return Object.freeze({
    sample(position: Vec3): number {
      return Math.max(
        sample_field(source, position, "subtraction source"),
        -sample_field(removed, position, "subtraction removal"),
      );
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
      const left_distance = sample_field(left, position, "smooth union left");
      const right_distance = sample_field(
        right,
        position,
        "smooth union right",
      );
      const amount = Math.max(
        0,
        Math.min(1, 0.5 + 0.5 * (right_distance - left_distance) / smoothing),
      );
      return finite_number(
        right_distance + (left_distance - right_distance) * amount -
          smoothing * amount * (1 - amount),
        "smooth union result",
      );
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
      return finite_number(
        sample_field(field, position, "offset source") - distance,
        "offset distance result",
      );
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
  const invalid = fields.findIndex((field) =>
    typeof field?.sample !== "function"
  );
  if (invalid >= 0) {
    throw new Error(
      `${operation} distance field ${invalid} sample must be a function`,
    );
  }
}

function sample_field(
  field: SignedDistanceField,
  position: Vec3,
  label: string,
): number {
  if (typeof field?.sample !== "function") {
    throw new Error(`${label} sample must be a function`);
  }
  let sampled: number;
  try {
    sampled = field.sample(position);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} sample failed: ${message}`, { cause: error });
  }
  return finite_number(sampled, `${label} sample`);
}

function positive(value: number, label: string): number {
  finite_number(value, label);
  if (value <= 0) throw new Error(`${label} ${value} must be positive`);
  return value;
}
