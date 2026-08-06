import type { DecodeResult, SchemaCodec, SnapshotValue } from "./schema.ts";

export const finite_number: SchemaCodec<number> = {
  encode(value) {
    if (!Number.isFinite(value)) {
      throw new Error(`ECS number ${String(value)} must be finite`);
    }
    return value;
  },
  decode(encoded_value) {
    return typeof encoded_value === "number" && Number.isFinite(encoded_value)
      ? { type: "decoded", value: encoded_value }
      : invalid(
        `expected a finite number, received ${describe(encoded_value)}`,
      );
  },
};

export const safe_integer: SchemaCodec<number> = {
  encode(value) {
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `ECS integer ${JSON.stringify(value)} must be a safe integer`,
      );
    }
    return value;
  },
  decode(encoded_value) {
    return typeof encoded_value === "number" &&
        Number.isSafeInteger(encoded_value)
      ? { type: "decoded", value: encoded_value }
      : invalid(`expected a safe integer, received ${describe(encoded_value)}`);
  },
};

export const text: SchemaCodec<string> = {
  encode(value) {
    return value;
  },
  decode(encoded_value) {
    return typeof encoded_value === "string"
      ? { type: "decoded", value: encoded_value }
      : invalid(`expected text, received ${describe(encoded_value)}`);
  },
};

export const boolean: SchemaCodec<boolean> = {
  encode(value) {
    return value;
  },
  decode(encoded_value) {
    return typeof encoded_value === "boolean"
      ? { type: "decoded", value: encoded_value }
      : invalid(`expected a boolean, received ${describe(encoded_value)}`);
  },
};

export function array<value>(
  codec: SchemaCodec<value>,
): SchemaCodec<readonly value[]> {
  return {
    encode(values) {
      return values.map((value) => codec.encode(value));
    },
    decode(encoded_value) {
      if (!Array.isArray(encoded_value)) {
        return invalid(
          `expected an array, received ${describe(encoded_value)}`,
        );
      }
      const values: value[] = [];
      for (const [index, encoded_entry] of encoded_value.entries()) {
        const decoded = codec.decode(encoded_entry);
        if (decoded.type === "invalid") {
          return invalid(`array entry ${index}: ${decoded.reason}`);
        }
        values.push(decoded.value);
      }
      return { type: "decoded", value: values };
    },
  };
}

export function mapped<value>(options: {
  readonly encode: (value: value) => SnapshotValue;
  readonly decode: (encoded_value: SnapshotValue) => DecodeResult<value>;
}): SchemaCodec<value> {
  return Object.freeze({ encode: options.encode, decode: options.decode });
}

function invalid<value = never>(reason: string): DecodeResult<value> {
  return { type: "invalid", reason };
}

function describe(value: SnapshotValue): string {
  return JSON.stringify(value);
}
