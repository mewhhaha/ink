import { mapped } from "./codec.ts";
import {
  define_component,
  define_resource,
  type SnapshotValue,
} from "./schema.ts";

export interface Position {
  readonly x: number;
  readonly y: number;
}

export interface Velocity {
  readonly x: number;
  readonly y: number;
}

function vector_codec(label: string) {
  return mapped<Position>({
    encode(value) {
      return { x: value.x, y: value.y };
    },
    decode(encoded_value) {
      if (
        !is_record(encoded_value) ||
        typeof encoded_value.x !== "number" ||
        !Number.isFinite(encoded_value.x) ||
        typeof encoded_value.y !== "number" ||
        !Number.isFinite(encoded_value.y)
      ) {
        return { type: "invalid", reason: `${label} requires finite x and y` };
      }
      return {
        type: "decoded",
        value: { x: encoded_value.x, y: encoded_value.y },
      };
    },
  });
}

export const position = define_component({
  id: "test.position",
  version: 1,
  codec: vector_codec("position"),
});

export const velocity = define_component<Velocity>({
  id: "test.velocity",
  version: 1,
  codec: vector_codec("velocity"),
});

export const score = define_resource({
  id: "test.score",
  version: 1,
  codec: mapped<number>({
    encode(value) {
      return value;
    },
    decode(encoded_value) {
      return typeof encoded_value === "number" &&
          Number.isSafeInteger(encoded_value)
        ? { type: "decoded", value: encoded_value }
        : { type: "invalid", reason: "score requires a safe integer" };
    },
  }),
});

function is_record(
  value: SnapshotValue,
): value is Readonly<Record<string, SnapshotValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
