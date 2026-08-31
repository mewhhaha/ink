declare const ray_tracing_geometry_id_brand: unique symbol;
declare const ray_tracing_instance_id_brand: unique symbol;
declare const ray_tracing_scene_revision_brand: unique symbol;
declare const ray_tracing_sample_sequence_brand: unique symbol;

export type RayTracingGeometryId = string & {
  readonly [ray_tracing_geometry_id_brand]: true;
};

export type RayTracingInstanceId = string & {
  readonly [ray_tracing_instance_id_brand]: true;
};

export type RayTracingSceneRevision = number & {
  readonly [ray_tracing_scene_revision_brand]: true;
};

export type RayTracingSampleSequence = number & {
  readonly [ray_tracing_sample_sequence_brand]: true;
};

export function ray_tracing_geometry_id(
  value: unknown,
): RayTracingGeometryId {
  return stable_identity(
    value,
    "ray tracing geometry identity",
  ) as RayTracingGeometryId;
}

export function ray_tracing_instance_id(
  value: unknown,
): RayTracingInstanceId {
  return stable_identity(
    value,
    "ray tracing instance identity",
  ) as RayTracingInstanceId;
}

export function ray_tracing_scene_revision(
  value: unknown,
): RayTracingSceneRevision {
  return nonnegative_safe_integer(
    value,
    "ray tracing scene revision",
  ) as RayTracingSceneRevision;
}

export function ray_tracing_sample_sequence(
  value: unknown,
): RayTracingSampleSequence {
  return nonnegative_safe_integer(
    value,
    "ray tracing sample sequence",
  ) as RayTracingSampleSequence;
}

function stable_identity(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} ${JSON.stringify(value)} must be a string`);
  }
  const parsed = value.trim();
  if (parsed.length === 0 || !/^[a-zA-Z0-9_.:/-]+$/.test(parsed)) {
    throw new Error(
      `${label} ${JSON.stringify(value)} must be a nonempty stable identity`,
    );
  }
  return parsed;
}

function nonnegative_safe_integer(value: unknown, label: string): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < 0
  ) {
    throw new Error(
      `${label} ${JSON.stringify(value)} must be a nonnegative safe integer`,
    );
  }
  return value;
}
