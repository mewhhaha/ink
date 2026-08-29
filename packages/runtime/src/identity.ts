declare const microseconds_brand: unique symbol;
declare const runtime_sequence_brand: unique symbol;

export type Microseconds = number & {
  readonly [microseconds_brand]: "Microseconds";
};

export type RuntimeSequence = number & {
  readonly [runtime_sequence_brand]: "RuntimeSequence";
};

export function microseconds(value: number): Microseconds {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `microseconds ${
        JSON.stringify(value)
      } must be a nonnegative safe integer`,
    );
  }
  return value as Microseconds;
}

export function runtime_sequence(value: number): RuntimeSequence {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `runtime sequence ${
        JSON.stringify(value)
      } must be a nonnegative safe integer`,
    );
  }
  return value as RuntimeSequence;
}
