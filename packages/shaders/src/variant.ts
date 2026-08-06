import { shader_identifier, shader_variant_key } from "./identity.ts";
import type {
  ResolvedShaderVariant,
  ShaderVariantField,
  ShaderVariantSchema,
  ShaderVariantValue,
} from "./model.ts";

export function resolve_shader_variant(
  schema: ShaderVariantSchema,
  supplied: Readonly<Record<string, ShaderVariantValue>> = {},
): ResolvedShaderVariant {
  const schema_id = schema.id.trim();
  if (
    schema_id.length === 0 ||
    !/^[a-zA-Z0-9_.:/-]+$/.test(schema_id)
  ) {
    throw new Error(
      `shader variant schema ${
        JSON.stringify(schema.id)
      } must be nonempty and stable`,
    );
  }
  const fields = [...schema.fields].sort((left, right) =>
    left.name.localeCompare(right.name)
  );
  const field_names = new Set<string>();
  const values: Record<string, ShaderVariantValue> = {};
  for (const field of fields) {
    const name = shader_identifier(
      field.name,
      `variant schema ${schema_id} field`,
    );
    if (field_names.has(name)) {
      throw new Error(
        `shader variant schema ${schema_id} repeats field ${name}`,
      );
    }
    field_names.add(name);
    validate_field(schema_id, field);
    const value = supplied[name] ?? field.default_value;
    validate_value(schema_id, field, value);
    values[name] = value;
  }
  const unknown = Object.keys(supplied).filter((name) => !field_names.has(name))
    .sort();
  if (unknown.length > 0) {
    throw new Error(
      `shader variant schema ${schema_id} received unknown fields ${
        unknown.join(", ")
      }`,
    );
  }
  const encoded = fields.map((field) =>
    `${field.name}=${encode_variant_value(values[field.name])}`
  ).join("&");
  return Object.freeze({
    key: shader_variant_key(`${schema_id}?${encoded}`),
    values: Object.freeze(values),
  });
}

function validate_field(schema: string, field: ShaderVariantField): void {
  if (field.type === "boolean") return;
  if (field.type === "enum") {
    const values = field.values.map((value) => value.trim());
    if (
      values.length === 0 || values.some((value) => value.length === 0) ||
      values.some((value, index) => value !== field.values[index])
    ) {
      throw new Error(
        `shader variant schema ${schema} enum ${field.name} is empty`,
      );
    }
    if (new Set(values).size !== values.length) {
      throw new Error(
        `shader variant schema ${schema} enum ${field.name} repeats a value`,
      );
    }
    if (!values.includes(field.default_value)) {
      throw new Error(
        `shader variant schema ${schema} enum ${field.name} default ${
          JSON.stringify(field.default_value)
        } is not declared`,
      );
    }
    return;
  }
  if (
    !Number.isFinite(field.minimum) || !Number.isFinite(field.maximum) ||
    field.minimum > field.maximum
  ) {
    throw new Error(
      `shader variant schema ${schema} field ${field.name} range ${field.minimum}..${field.maximum} is invalid`,
    );
  }
  if (
    field.type === "integer" &&
    (!Number.isSafeInteger(field.minimum) ||
      !Number.isSafeInteger(field.maximum))
  ) {
    throw new Error(
      `shader variant schema ${schema} integer field ${field.name} bounds must be safe integers`,
    );
  }
  validate_value(schema, field, field.default_value);
}

function validate_value(
  schema: string,
  field: ShaderVariantField,
  value: ShaderVariantValue,
): void {
  if (field.type === "boolean") {
    if (typeof value !== "boolean") {
      failure(schema, field.name, value, "boolean");
    }
    return;
  }
  if (field.type === "enum") {
    if (typeof value !== "string" || !field.values.includes(value)) {
      failure(schema, field.name, value, `one of ${field.values.join(", ")}`);
    }
    return;
  }
  if (
    typeof value !== "number" || !Number.isFinite(value) ||
    value < field.minimum || value > field.maximum ||
    (field.type === "integer" && !Number.isSafeInteger(value))
  ) {
    failure(
      schema,
      field.name,
      value,
      `${field.type} within ${field.minimum}..${field.maximum}`,
    );
  }
}

function failure(
  schema: string,
  field: string,
  value: ShaderVariantValue,
  expected: string,
): never {
  throw new Error(
    `shader variant schema ${schema} field ${field} value ${
      JSON.stringify(value)
    } must be ${expected}`,
  );
}

function encode_variant_value(value: ShaderVariantValue): string {
  return typeof value === "string" ? encodeURIComponent(value) : String(value);
}
