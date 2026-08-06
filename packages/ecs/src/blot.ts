export interface BlotEntity {
  readonly index: number;
  readonly generation: number;
}

export type BlotEntityResult =
  | { readonly type: "decoded"; readonly entity: BlotEntity }
  | { readonly type: "invalid"; readonly reason: string };

export interface BlotComponentSchema {
  readonly id: number;
  readonly name: string;
  readonly fields: readonly string[];
}

export function encode_blot_entity(
  entity: BlotEntity,
  capacity: number,
): number {
  parse_capacity(capacity);
  if (
    !Number.isSafeInteger(entity.index) || entity.index < 0 ||
    entity.index >= capacity
  ) {
    throw new Error(
      `Blot ECS entity index ${
        JSON.stringify(entity.index)
      } must be between 0 and ${capacity - 1}`,
    );
  }
  if (!Number.isSafeInteger(entity.generation) || entity.generation < 0) {
    throw new Error(
      `Blot ECS entity generation ${
        JSON.stringify(entity.generation)
      } must be a nonnegative safe integer`,
    );
  }
  const encoded = entity.generation * capacity + entity.index;
  if (!Number.isSafeInteger(encoded)) {
    throw new Error(
      `Blot ECS entity (${entity.index}, ${entity.generation}) exceeds the safe integer range at capacity ${capacity}`,
    );
  }
  return encoded;
}

export function decode_blot_entity(
  encoded: number,
  capacity: number,
): BlotEntityResult {
  parse_capacity(capacity);
  if (!Number.isSafeInteger(encoded) || encoded < 0) {
    return {
      type: "invalid",
      reason: `Blot ECS entity ${
        JSON.stringify(encoded)
      } must be a nonnegative safe integer`,
    };
  }
  return {
    type: "decoded",
    entity: {
      index: encoded % capacity,
      generation: Math.floor(encoded / capacity),
    },
  };
}

export function parse_blot_component_schema(
  id: number,
  name: string,
  encoded_fields: string,
): BlotComponentSchema {
  if (!Number.isSafeInteger(id) || id < 0) {
    throw new Error(
      `Blot ECS component id ${
        JSON.stringify(id)
      } must be a nonnegative safe integer`,
    );
  }
  const parsed_name = name.trim();
  if (parsed_name.length === 0) {
    throw new Error("Blot ECS component name cannot be empty");
  }
  const fields = encoded_fields.length === 0
    ? []
    : encoded_fields.split(";").map(
      (encoded_field, field_index) => {
        const [field_name, field_type, ...remainder] = encoded_field.split(":");
        if (
          !field_name || field_type !== "Int" || remainder.length > 0 ||
          !/^[A-Za-z][A-Za-z0-9_]*$/.test(field_name)
        ) {
          throw new Error(
            `Blot ECS component ${
              JSON.stringify(parsed_name)
            } field ${field_index} ${
              JSON.stringify(encoded_field)
            } must use name:Int`,
          );
        }
        return field_name;
      },
    );
  if (new Set(fields).size !== fields.length) {
    throw new Error(
      `Blot ECS component ${
        JSON.stringify(parsed_name)
      } contains duplicate fields`,
    );
  }
  return Object.freeze({
    id,
    name: parsed_name,
    fields: Object.freeze(fields),
  });
}

export function parse_blot_indexed_seed(
  source: string,
  field_count: number,
  capacity: number,
): readonly (readonly bigint[])[] {
  parse_capacity(capacity);
  if (!Number.isSafeInteger(field_count) || field_count < 1) {
    throw new Error(
      `Blot ECS seed field count ${
        JSON.stringify(field_count)
      } must be a positive safe integer`,
    );
  }
  const encoded_rows = source.trim().split(";");
  if (encoded_rows.at(-1) === "") encoded_rows.pop();
  if (encoded_rows.length > capacity) {
    throw new Error(
      `ECS seed has ${encoded_rows.length} entities but world capacity is ${capacity}`,
    );
  }
  return encoded_rows.map((encoded_row, entity) => {
    const encoded_values = encoded_row.trim().split(",");
    if (encoded_values.length !== field_count) {
      throw new Error(
        `ECS seed entity ${entity} has ${encoded_values.length} fields; component requires ${field_count}`,
      );
    }
    return encoded_values.map((encoded_value, field) =>
      parse_blot_cell(encoded_value, entity, field)
    );
  });
}

export function parse_blot_resource_seed(
  source: string,
  field_count: number,
): readonly bigint[] {
  const values = parse_blot_indexed_seed(`${source};`, field_count, 1)[0];
  if (!values) throw new Error("ECS resource seed must contain one value");
  return values;
}

function parse_blot_cell(
  source: string,
  entity: number,
  field: number,
): bigint {
  const trimmed = source.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(
      `ECS seed entity ${entity} field ${field} ${
        JSON.stringify(trimmed)
      } must be an integer`,
    );
  }
  const value = BigInt(trimmed);
  const minimum = -(1n << 63n);
  const maximum = (1n << 63n) - 1n;
  if (value < minimum || value > maximum) {
    throw new Error(
      `ECS seed entity ${entity} field ${field} ${value} is outside signed 64-bit range`,
    );
  }
  return value;
}

function parse_capacity(capacity: number): void {
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new Error(
      `Blot ECS capacity ${
        JSON.stringify(capacity)
      } must be a positive safe integer`,
    );
  }
}
