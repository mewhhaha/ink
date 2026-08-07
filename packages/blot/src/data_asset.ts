export interface BlotIntegerDataAsset {
  readonly id: number;
  readonly fields: readonly (readonly number[])[];
}

export function parse_blot_integer_data_asset(
  id: number,
  source: string,
): BlotIntegerDataAsset {
  if (!Number.isSafeInteger(id) || id < 0) {
    throw new Error(`Blot data asset id ${JSON.stringify(id)} is invalid`);
  }
  if (typeof source !== "string") {
    throw new Error(`Blot data asset ${id} source must be a string`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    throw new Error(`Blot data asset ${id} is not valid JSON`, { cause });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Blot data asset ${id} must be an object`);
  }
  if (Reflect.get(parsed, "format") !== "blot-integer-data") {
    throw new Error(
      `Blot data asset ${id} format ${
        JSON.stringify(Reflect.get(parsed, "format"))
      } must be "blot-integer-data"`,
    );
  }
  if (Reflect.get(parsed, "version") !== 1) {
    throw new Error(
      `Blot data asset ${id} version ${
        JSON.stringify(Reflect.get(parsed, "version"))
      } must be 1`,
    );
  }
  const fields = Reflect.get(parsed, "fields");
  if (!Array.isArray(fields)) {
    throw new Error(`Blot data asset ${id} fields must be an array`);
  }
  return {
    id,
    fields: fields.map((field, field_index) => {
      if (!Array.isArray(field)) {
        throw new Error(
          `Blot data asset ${id} field ${field_index} must be an array`,
        );
      }
      return field.map((value, value_index) => {
        if (!Number.isSafeInteger(value)) {
          throw new Error(
            `Blot data asset ${id} field ${field_index} value ${value_index} ${
              JSON.stringify(value)
            } must be a safe integer`,
          );
        }
        return value;
      });
    }),
  };
}
