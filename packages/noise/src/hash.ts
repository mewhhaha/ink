import type { NoiseSeed } from "./domain.ts";

export function hash_u32(
  seed: NoiseSeed,
  x: number,
  y = 0,
  z = 0,
  lane = 0,
): number {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new Error(
      `noise hash seed ${seed} must be an unsigned 32-bit integer`,
    );
  }
  for (
    const [label, coordinate] of [["x", x], ["y", y], ["z", z], [
      "lane",
      lane,
    ]] as const
  ) {
    if (
      !Number.isSafeInteger(coordinate) || coordinate < -0x8000_0000 ||
      coordinate > 0x7fff_ffff
    ) {
      throw new Error(
        `noise hash ${label} coordinate ${coordinate} must be a signed 32-bit integer`,
      );
    }
  }
  let value = seed >>> 0;
  value ^= Math.imul(x | 0, 0x9e37_79b1) >>> 0;
  value ^= Math.imul(y | 0, 0x85eb_ca77) >>> 0;
  value ^= Math.imul(z | 0, 0xc2b2_ae3d) >>> 0;
  value ^= Math.imul(lane | 0, 0x27d4_eb2f) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x7feb_352d) >>> 0;
  value = Math.imul(value ^ (value >>> 15), 0x846c_a68b) >>> 0;
  return (value ^ (value >>> 16)) >>> 0;
}

export function hash_unit(
  seed: NoiseSeed,
  x: number,
  y = 0,
  z = 0,
  lane = 0,
): number {
  return hash_u32(seed, x, y, z, lane) / 0x1_0000_0000;
}

export function hash_signed(
  seed: NoiseSeed,
  x: number,
  y = 0,
  z = 0,
  lane = 0,
): number {
  return hash_unit(seed, x, y, z, lane) * 2 - 1;
}
