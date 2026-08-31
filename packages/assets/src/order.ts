export function compare_code_units(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
