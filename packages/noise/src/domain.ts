import type { Vec2, Vec3 } from "@ink/math/vector.ts";

declare const noise_seed_brand: unique symbol;
declare const noise_period_1d_brand: unique symbol;
declare const noise_period_2d_brand: unique symbol;
declare const noise_period_3d_brand: unique symbol;

export type NoiseSeed = number & { readonly [noise_seed_brand]: true };

export interface NoisePeriod1d {
  readonly x: number;
  readonly [noise_period_1d_brand]: true;
}

export interface NoisePeriod2d {
  readonly x: number;
  readonly y: number;
  readonly [noise_period_2d_brand]: true;
}

export interface NoisePeriod3d extends NoisePeriod2d {
  readonly z: number;
  readonly [noise_period_3d_brand]: true;
}

export interface NoiseInput1d {
  readonly position: number;
  readonly seed: NoiseSeed;
  readonly period?: NoisePeriod1d;
}

export interface NoiseInput2d {
  readonly position: Vec2;
  readonly seed: NoiseSeed;
  readonly period?: NoisePeriod2d;
}

export interface NoiseInput3d {
  readonly position: Vec3;
  readonly seed: NoiseSeed;
  readonly period?: NoisePeriod3d;
}

export function noise_seed(value: number): NoiseSeed {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`noise seed ${value} must be an unsigned 32-bit integer`);
  }
  return value as NoiseSeed;
}

export function noise_period_1d(x: number): NoisePeriod1d {
  return Object.freeze({
    x: positive_period(x, "noise period x"),
  }) as NoisePeriod1d;
}

export function noise_period_2d(x: number, y: number): NoisePeriod2d {
  return Object.freeze({
    x: positive_period(x, "noise period x"),
    y: positive_period(y, "noise period y"),
  }) as NoisePeriod2d;
}

export function noise_period_3d(
  x: number,
  y: number,
  z: number,
): NoisePeriod3d {
  return Object.freeze({
    x: positive_period(x, "noise period x"),
    y: positive_period(y, "noise period y"),
    z: positive_period(z, "noise period z"),
  }) as NoisePeriod3d;
}

export function finite_position(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} ${value} must be finite`);
  }
  const lattice = Math.floor(value);
  if (lattice < -0x8000_0000 || lattice > 0x7fff_fffe) {
    throw new Error(
      `${label} ${value} must have a lattice coordinate within signed 32-bit range`,
    );
  }
  return value;
}

function positive_period(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 0x7fff_ffff) {
    throw new Error(
      `${label} ${value} must be a positive signed 32-bit integer`,
    );
  }
  return value;
}
