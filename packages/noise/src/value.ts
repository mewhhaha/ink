import {
  finite_position,
  type NoiseInput1d,
  type NoiseInput2d,
  type NoiseInput3d,
} from "./domain.ts";
import { hash_signed } from "./hash.ts";
import { fade, interpolate, wrap_lattice } from "./internal.ts";

export function value_noise_1d(input: NoiseInput1d): number {
  const x = finite_position(input.position, "1D noise position");
  const x0 = Math.floor(x);
  const amount = fade(x - x0);
  return interpolate(
    hash_signed(input.seed, wrap_lattice(x0, input.period?.x)),
    hash_signed(input.seed, wrap_lattice(x0 + 1, input.period?.x)),
    amount,
  );
}

export function value_noise_2d(input: NoiseInput2d): number {
  const x = finite_position(input.position.x, "2D noise position x");
  const y = finite_position(input.position.y, "2D noise position y");
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const ax = fade(x - x0);
  const ay = fade(y - y0);
  const lattice_x0 = wrap_lattice(x0, input.period?.x);
  const lattice_x1 = wrap_lattice(x0 + 1, input.period?.x);
  const lattice_y0 = wrap_lattice(y0, input.period?.y);
  const lattice_y1 = wrap_lattice(y0 + 1, input.period?.y);
  const lower = interpolate(
    hash_signed(input.seed, lattice_x0, lattice_y0),
    hash_signed(input.seed, lattice_x1, lattice_y0),
    ax,
  );
  const upper = interpolate(
    hash_signed(input.seed, lattice_x0, lattice_y1),
    hash_signed(input.seed, lattice_x1, lattice_y1),
    ax,
  );
  return interpolate(lower, upper, ay);
}

export function value_noise_3d(input: NoiseInput3d): number {
  const x = finite_position(input.position.x, "3D noise position x");
  const y = finite_position(input.position.y, "3D noise position y");
  const z = finite_position(input.position.z, "3D noise position z");
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const amounts = [fade(x - x0), fade(y - y0), fade(z - z0)] as const;
  const values = new Array<number>(8);
  for (let dz = 0; dz <= 1; dz++) {
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        values[dx + dy * 2 + dz * 4] = hash_signed(
          input.seed,
          wrap_lattice(x0 + dx, input.period?.x),
          wrap_lattice(y0 + dy, input.period?.y),
          wrap_lattice(z0 + dz, input.period?.z),
        );
      }
    }
  }
  const z_lower = interpolate(
    interpolate(
      interpolate(values[0], values[1], amounts[0]),
      interpolate(values[2], values[3], amounts[0]),
      amounts[1],
    ),
    interpolate(
      interpolate(values[4], values[5], amounts[0]),
      interpolate(values[6], values[7], amounts[0]),
      amounts[1],
    ),
    amounts[2],
  );
  return z_lower;
}
