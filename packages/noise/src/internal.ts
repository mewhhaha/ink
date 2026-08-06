export function wrap_lattice(
  coordinate: number,
  period: number | undefined,
): number {
  if (period === undefined) return coordinate;
  return ((coordinate % period) + period) % period;
}

export function fade(value: number): number {
  return value * value * value * (value * (value * 6 - 15) + 10);
}

export function interpolate(
  start: number,
  finish: number,
  amount: number,
): number {
  return start + (finish - start) * amount;
}
