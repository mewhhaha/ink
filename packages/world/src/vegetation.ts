import type { Vec3 } from "@ink/math/vector.ts";
import { vec3 } from "@ink/math/vector.ts";
import type { TerrainDescriptor } from "./terrain.ts";
import { sample_terrain } from "./terrain.ts";
import { nonnegative_integer, positive_finite } from "./identity.ts";

export interface VegetationSpecies {
  readonly id: string;
  readonly weight: number;
  readonly minimum_scale?: number;
  readonly maximum_scale?: number;
}

export interface VegetationPlacementInput {
  readonly seed: bigint;
  readonly generator_version: string;
  readonly region_revision: number;
  readonly terrain: TerrainDescriptor;
  readonly spacing: number;
  readonly density: Float32Array;
  readonly exclusions: Uint8Array;
  readonly species: readonly VegetationSpecies[];
  readonly maximum_instances: number;
}

export interface VegetationInstance {
  readonly id: string;
  readonly species: string;
  readonly position: Vec3;
  readonly rotation_radians: number;
  readonly scale: number;
}

const u64_mask = (1n << 64n) - 1n;

export function place_vegetation(
  input: VegetationPlacementInput,
): readonly VegetationInstance[] {
  if (typeof input.seed !== "bigint") {
    throw new Error(
      `vegetation seed ${JSON.stringify(input.seed)} must be a bigint`,
    );
  }
  if (input.seed < 0n || input.seed > u64_mask) {
    throw new Error(
      `vegetation seed ${input.seed} must be an unsigned 64-bit integer`,
    );
  }
  if (typeof input.generator_version !== "string") {
    throw new Error("vegetation generator version must be a string");
  }
  const version = input.generator_version.trim();
  if (version.length === 0) {
    throw new Error("vegetation generator version cannot be empty");
  }
  const revision = nonnegative_integer(
    input.region_revision,
    "vegetation region revision",
  );
  const spacing = positive_finite(input.spacing, "vegetation spacing");
  const maximum = nonnegative_integer(
    input.maximum_instances,
    "vegetation maximum instances",
  );
  const vertex_count = input.terrain.width * input.terrain.depth;
  if (
    input.density.length !== vertex_count ||
    input.exclusions.length !== vertex_count
  ) {
    throw new Error(
      `vegetation density ${input.density.length} and exclusions ${input.exclusions.length} must match terrain vertices ${vertex_count}`,
    );
  }
  for (const [index, density] of input.density.entries()) {
    if (!Number.isFinite(density) || density < 0 || density > 1) {
      throw new Error(`vegetation density ${index} ${density} must be in 0..1`);
    }
  }
  if ([...input.exclusions].some((value) => value !== 0 && value !== 1)) {
    throw new Error("vegetation exclusions must contain only 0 or 1");
  }
  const species = parse_species(input.species);
  const width_meters = (input.terrain.width - 1) * input.terrain.spacing;
  const depth_meters = (input.terrain.depth - 1) * input.terrain.spacing;
  const columns = Math.floor(width_meters / spacing);
  const rows = Math.floor(depth_meters / spacing);
  const candidates = (columns + 1) * (rows + 1);
  if (!Number.isSafeInteger(candidates) || candidates > 16_777_216) {
    throw new Error(
      `vegetation grid ${columns + 1}x${rows + 1} exceeds 16777216 candidates`,
    );
  }
  const instances: VegetationInstance[] = [];
  for (let row = 0; row <= rows && instances.length < maximum; row += 1) {
    for (
      let column = 0;
      column <= columns && instances.length < maximum;
      column += 1
    ) {
      const identity_source =
        `${input.seed}:${version}:${revision}:${column}:${row}`;
      const first = hash(identity_source);
      const second = hash(`${identity_source}:jitter`);
      const x = Math.min(
        width_meters,
        (column + unit(first) * 0.8 - 0.4) * spacing,
      );
      const z = Math.min(
        depth_meters,
        (row + unit(second) * 0.8 - 0.4) * spacing,
      );
      if (x < 0 || z < 0) continue;
      const grid_x = Math.round(x / input.terrain.spacing);
      const grid_z = Math.round(z / input.terrain.spacing);
      const vertex = grid_z * input.terrain.width + grid_x;
      if (
        input.exclusions[vertex] === 1 ||
        unit(hash(`${identity_source}:density`)) >= input.density[vertex]
      ) {
        continue;
      }
      const sampled = sample_terrain(input.terrain, x, z);
      if (sampled.type === "outside" || sampled.hole) continue;
      const selected = select_species(
        species,
        unit(hash(`${identity_source}:species`)),
      );
      const scale_amount = unit(hash(`${identity_source}:scale`));
      const scale = selected.minimum_scale +
        (selected.maximum_scale - selected.minimum_scale) * scale_amount;
      instances.push(Object.freeze({
        id: `vegetation:${
          hash(`${identity_source}:${selected.id}`).toString(16).padStart(
            16,
            "0",
          )
        }`,
        species: selected.id,
        position: vec3(x, sampled.height, z),
        rotation_radians: unit(hash(`${identity_source}:rotation`)) * Math.PI *
          2,
        scale,
      }));
    }
  }
  return Object.freeze(instances);
}

interface ParsedSpecies {
  readonly id: string;
  readonly weight: number;
  readonly minimum_scale: number;
  readonly maximum_scale: number;
}

function parse_species(
  source: readonly VegetationSpecies[],
): readonly ParsedSpecies[] {
  if (source.length === 0) {
    throw new Error("vegetation requires at least one species");
  }
  const identities = new Set<string>();
  return source.map((entry, index) => {
    if (typeof entry.id !== "string") {
      throw new Error(`vegetation species ${index} id must be a string`);
    }
    const id = entry.id.trim();
    if (id.length === 0 || identities.has(id)) {
      throw new Error(
        `vegetation species ${index} id ${
          JSON.stringify(entry.id)
        } is empty or duplicated`,
      );
    }
    identities.add(id);
    const weight = positive_finite(
      entry.weight,
      `vegetation species ${id} weight`,
    );
    const minimum_scale = positive_finite(
      entry.minimum_scale ?? 1,
      `vegetation species ${id} minimum scale`,
    );
    const maximum_scale = positive_finite(
      entry.maximum_scale ?? 1,
      `vegetation species ${id} maximum scale`,
    );
    if (minimum_scale > maximum_scale) {
      throw new Error(
        `vegetation species ${
          JSON.stringify(id)
        } minimum scale exceeds maximum`,
      );
    }
    return Object.freeze({ id, weight, minimum_scale, maximum_scale });
  });
}

function select_species(
  species: readonly ParsedSpecies[],
  amount: number,
): ParsedSpecies {
  const total = species.reduce((sum, entry) => sum + entry.weight, 0);
  if (!Number.isFinite(total)) {
    throw new Error(`vegetation species total weight ${total} must be finite`);
  }
  let remaining = amount * total;
  for (const entry of species) {
    remaining -= entry.weight;
    if (remaining <= 0) return entry;
  }
  return species.at(-1)!;
}

function hash(source: string): bigint {
  let value = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(source)) {
    value ^= BigInt(byte);
    value = value * 0x100000001b3n & u64_mask;
  }
  return value;
}

function unit(value: bigint): number {
  return Number(value >> 11n) / 2 ** 53;
}
