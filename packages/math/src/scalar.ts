export const DEFAULT_EPSILON = 1e-9;

export function finite_number(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be finite, received ${String(value)}`);
  }
  return value;
}

export function clamp(value: number, minimum: number, maximum: number): number {
  finite_number(value, "value");
  finite_number(minimum, "minimum");
  finite_number(maximum, "maximum");
  if (minimum > maximum) {
    throw new Error(`minimum ${minimum} exceeds maximum ${maximum}`);
  }
  return Math.min(Math.max(value, minimum), maximum);
}

export function lerp(start: number, finish: number, amount: number): number {
  finite_number(start, "start");
  finite_number(finish, "finish");
  finite_number(amount, "amount");
  const value = amount >= 0 && amount <= 1
    ? start * (1 - amount) + finish * amount
    : start + (finish - start) * amount;
  return finite_number(value, "interpolated value");
}

export function inverse_lerp(
  start: number,
  finish: number,
  value: number,
): number {
  finite_number(start, "start");
  finite_number(finish, "finish");
  finite_number(value, "value");
  if (start === finish) {
    throw new Error(`cannot inverse-lerp equal endpoints ${start}`);
  }
  return finite_number(
    (value - start) / (finish - start),
    "inverse interpolation",
  );
}

export function wrap(value: number, minimum: number, maximum: number): number {
  finite_number(value, "value");
  finite_number(minimum, "minimum");
  finite_number(maximum, "maximum");
  const range = maximum - minimum;
  if (range <= 0) {
    throw new Error(
      `wrap range [${minimum}, ${maximum}) must have positive length`,
    );
  }
  return minimum + ((value - minimum) % range + range) % range;
}

export function wrap_angle(radians: number): number {
  return wrap(radians, -Math.PI, Math.PI);
}

export function shortest_angle_delta(start: number, finish: number): number {
  finite_number(start, "start angle");
  finite_number(finish, "finish angle");
  return wrap_angle(finish - start);
}

export function approximately_equal(
  left: number,
  right: number,
  epsilon = DEFAULT_EPSILON,
): boolean {
  finite_number(left, "left value");
  finite_number(right, "right value");
  finite_number(epsilon, "epsilon");
  if (epsilon < 0) {
    throw new Error(`epsilon must be non-negative, received ${epsilon}`);
  }
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= epsilon * scale;
}
