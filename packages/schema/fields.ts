/**
 * Field builders. A schema field describes one value in a component,
 * resource or event: how it is stored in the numeric state packet, how Blot
 * sees it, and how an inspector edits it.
 */

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
export type Vec4 = [number, number, number, number];

/** Presentation hints. They never change the packed layout. */
export interface FieldMeta {
  label?: string;
  description?: string;
  /** Hide the field from generic inspectors. */
  hidden?: boolean;
  /** Show but do not allow editing. */
  readonly?: boolean;
  /** Inspector group heading. */
  group?: string;
}

export interface NumberMeta extends FieldMeta {
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}

export type Field =
  | ({ kind: "f32"; default: number } & NumberMeta)
  | ({ kind: "u32"; default: number } & NumberMeta)
  | ({ kind: "bool"; default: boolean } & FieldMeta)
  | ({ kind: "vec2"; default: Vec2 } & NumberMeta)
  | ({ kind: "vec3"; default: Vec3 } & NumberMeta)
  | ({ kind: "vec4"; default: Vec4 } & NumberMeta)
  | ({ kind: "quat"; default: Vec4 } & FieldMeta)
  | ({ kind: "color"; default: Vec4 } & FieldMeta)
  | ({ kind: "entity" } & FieldMeta)
  | ({ kind: "asset"; asset: string } & FieldMeta)
  | ({ kind: "message" } & FieldMeta)
  | (
    & {
      kind: "enum";
      values: readonly string[];
      default: string;
      /** Blot type name; defaults to the owner and field name. */
      name?: string;
    }
    & FieldMeta
  )
  | (
    & {
      kind: "struct";
      fields: Record<string, Field>;
      /** Blot type name; defaults to the owner and field name. */
      name?: string;
    }
    & FieldMeta
  )
  | (
    & {
      kind: "list";
      of: Field;
      /** Largest accepted length. */
      max?: number;
    }
    & FieldMeta
  );

export type FieldKind = Field["kind"];

export const f32 = (
  options: { default?: number } & NumberMeta = {},
): Field => ({ ...options, kind: "f32", default: options.default ?? 0 });

/** An unsigned integer, exact up to 2^24 - 1 in the numeric packet. */
export const u32 = (
  options: { default?: number } & NumberMeta = {},
): Field => ({ ...options, kind: "u32", default: options.default ?? 0 });

export const bool = (
  options: { default?: boolean } & FieldMeta = {},
): Field => ({ ...options, kind: "bool", default: options.default ?? false });

export const vec2 = (
  options: { default?: Vec2 } & NumberMeta = {},
): Field => ({ ...options, kind: "vec2", default: options.default ?? [0, 0] });

export const vec3 = (
  options: { default?: Vec3 } & NumberMeta = {},
): Field => ({
  ...options,
  kind: "vec3",
  default: options.default ?? [0, 0, 0],
});

export const vec4 = (
  options: { default?: Vec4 } & NumberMeta = {},
): Field => ({
  ...options,
  kind: "vec4",
  default: options.default ?? [0, 0, 0, 0],
});

/** A rotation quaternion `[x, y, z, w]`. */
export const quat = (
  options: { default?: Vec4 } & FieldMeta = {},
): Field => ({
  ...options,
  kind: "quat",
  default: options.default ?? [0, 0, 0, 1],
});

/** An RGBA color, sRGB 0..1 like CSS. */
export const color = (
  options: { default?: Vec4 } & FieldMeta = {},
): Field => ({
  ...options,
  kind: "color",
  default: options.default ?? [1, 1, 1, 1],
});

/** Another entity's id; 0 means none. */
export const entity = (options: FieldMeta = {}): Field => ({
  ...options,
  kind: "entity",
});

/** An asset of `kind` (`mesh`, `texture`, `sound`, ...); 0 means none. */
export const asset = (kind: string, options: FieldMeta = {}): Field => ({
  ...options,
  kind: "asset",
  asset: kind,
});

/** A message from the schema's `messages` table. */
export const message = (options: FieldMeta = {}): Field => ({
  ...options,
  kind: "message",
});

export const enumOf = (
  values: readonly string[],
  options: { default?: string; name?: string } & FieldMeta = {},
): Field => ({
  ...options,
  kind: "enum",
  values,
  default: options.default ?? values[0],
});

export const struct = (
  fields: Record<string, Field>,
  options: { name?: string } & FieldMeta = {},
): Field => ({ ...options, kind: "struct", fields });

/** A variable-length list of fixed-size values. */
export const list = (
  of: Field,
  options: { max?: number } & FieldMeta = {},
): Field => ({ ...options, kind: "list", of });

// Input actions -------------------------------------------------------------

/** Physical inputs use `KeyboardEvent.code` names and `MouseLeft`,
 * `MouseRight`, `MouseMiddle`. */
export type Action =
  | { kind: "button"; keys: string[]; description?: string }
  | {
    kind: "axis";
    negative: string[];
    positive: string[];
    description?: string;
  }
  | {
    kind: "axis2";
    left: string[];
    right: string[];
    down: string[];
    up: string[];
    description?: string;
  };

export const button = (...keys: string[]): Action => ({
  kind: "button",
  keys,
});

export const axis = (negative: string[], positive: string[]): Action => ({
  kind: "axis",
  negative,
  positive,
});

export const axis2 = (
  keys: { left: string[]; right: string[]; down: string[]; up: string[] },
): Action => ({ kind: "axis2", ...keys });
