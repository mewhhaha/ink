import { vec2, vec3 } from "@ink/math/vector.ts";
import {
  finite_position,
  type NoiseInput1d,
  type NoiseInput2d,
  type NoiseInput3d,
} from "../domain.ts";
import { hash_u32 } from "../hash.ts";
import { fade, interpolate, wrap_lattice } from "../internal.ts";

const diagonal = 0.7071067811865476;
const gradients_2d = [
  vec2(1, 0),
  vec2(-1, 0),
  vec2(0, 1),
  vec2(0, -1),
  vec2(diagonal, diagonal),
  vec2(-diagonal, diagonal),
  vec2(diagonal, -diagonal),
  vec2(-diagonal, -diagonal),
] as const;
const gradients_3d = [
  vec3(diagonal, diagonal, 0),
  vec3(-diagonal, diagonal, 0),
  vec3(diagonal, -diagonal, 0),
  vec3(-diagonal, -diagonal, 0),
  vec3(diagonal, 0, diagonal),
  vec3(-diagonal, 0, diagonal),
  vec3(diagonal, 0, -diagonal),
  vec3(-diagonal, 0, -diagonal),
  vec3(0, diagonal, diagonal),
  vec3(0, -diagonal, diagonal),
  vec3(0, diagonal, -diagonal),
  vec3(0, -diagonal, -diagonal),
] as const;

export function gradient_noise_1d(input: NoiseInput1d): number {
  const x = finite_position(input.position, "1D gradient noise position");
  const x0 = Math.floor(x);
  const offset = x - x0;
  const left =
    (hash_u32(input.seed, wrap_lattice(x0, input.period?.x)) & 1) === 0
      ? offset
      : -offset;
  const right_offset = offset - 1;
  const right =
    (hash_u32(input.seed, wrap_lattice(x0 + 1, input.period?.x)) & 1) === 0
      ? right_offset
      : -right_offset;
  return interpolate(left, right, fade(offset)) * 2;
}

export function gradient_noise_2d(input: NoiseInput2d): number {
  const x = finite_position(input.position.x, "2D gradient noise position x");
  const y = finite_position(input.position.y, "2D gradient noise position y");
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const ox = x - x0;
  const oy = y - y0;
  const dots = new Array<number>(4);
  for (let dy = 0; dy <= 1; dy++) {
    for (let dx = 0; dx <= 1; dx++) {
      const gradient = gradients_2d[
        hash_u32(
          input.seed,
          wrap_lattice(x0 + dx, input.period?.x),
          wrap_lattice(y0 + dy, input.period?.y),
        ) & 7
      ];
      dots[dx + dy * 2] = gradient.x * (ox - dx) + gradient.y * (oy - dy);
    }
  }
  return interpolate(
    interpolate(dots[0], dots[1], fade(ox)),
    interpolate(dots[2], dots[3], fade(ox)),
    fade(oy),
  ) * 1.4142135623730951;
}

export function gradient_noise_3d(input: NoiseInput3d): number {
  const x = finite_position(input.position.x, "3D gradient noise position x");
  const y = finite_position(input.position.y, "3D gradient noise position y");
  const z = finite_position(input.position.z, "3D gradient noise position z");
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const offsets = [x - x0, y - y0, z - z0] as const;
  const dots = new Array<number>(8);
  for (let dz = 0; dz <= 1; dz++) {
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        const gradient = gradients_3d[
          hash_u32(
            input.seed,
            wrap_lattice(x0 + dx, input.period?.x),
            wrap_lattice(y0 + dy, input.period?.y),
            wrap_lattice(z0 + dz, input.period?.z),
          ) % gradients_3d.length
        ];
        dots[dx + dy * 2 + dz * 4] = gradient.x * (offsets[0] - dx) +
          gradient.y * (offsets[1] - dy) + gradient.z * (offsets[2] - dz);
      }
    }
  }
  const x00 = interpolate(dots[0], dots[1], fade(offsets[0]));
  const x10 = interpolate(dots[2], dots[3], fade(offsets[0]));
  const x01 = interpolate(dots[4], dots[5], fade(offsets[0]));
  const x11 = interpolate(dots[6], dots[7], fade(offsets[0]));
  return interpolate(
    interpolate(x00, x10, fade(offsets[1])),
    interpolate(x01, x11, fade(offsets[1])),
    fade(offsets[2]),
  ) * 1.1547005383792517;
}
