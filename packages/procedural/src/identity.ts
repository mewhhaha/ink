declare const procedural_seed_brand: unique symbol;
declare const generator_revision_brand: unique symbol;

export type ProceduralSeed = bigint & {
  readonly [procedural_seed_brand]: true;
};
export type GeneratorRevision = string & {
  readonly [generator_revision_brand]: true;
};

const unsigned_64_maximum = (1n << 64n) - 1n;

export function procedural_seed(value: bigint): ProceduralSeed {
  if (typeof value !== "bigint" || value < 0n || value > unsigned_64_maximum) {
    throw new Error(
      `procedural seed ${value} must be an unsigned 64-bit integer`,
    );
  }
  return value as ProceduralSeed;
}

export function generator_revision(value: string): GeneratorRevision {
  if (typeof value !== "string") {
    throw new Error(
      `generator revision ${JSON.stringify(value)} must be a string`,
    );
  }
  const revision = value.trim();
  if (revision.length === 0) {
    throw new Error(
      `generator revision ${JSON.stringify(value)} cannot be empty`,
    );
  }
  return revision as GeneratorRevision;
}

export function coordinate_random(
  seed: ProceduralSeed,
  revision: GeneratorRevision,
  coordinates: readonly number[],
  channel: string,
): number {
  procedural_seed(seed);
  if (generator_revision(revision) !== revision) {
    throw new Error(
      `generator revision ${JSON.stringify(revision)} is not canonical`,
    );
  }
  for (const [index, coordinate] of coordinates.entries()) {
    if (!Number.isSafeInteger(coordinate)) {
      throw new Error(
        `procedural coordinate ${index} ${coordinate} must be a safe integer`,
      );
    }
  }
  if (typeof channel !== "string") {
    throw new Error(
      `procedural random channel ${JSON.stringify(channel)} must be a string`,
    );
  }
  const normalized_channel = channel.trim();
  if (normalized_channel.length === 0) {
    throw new Error(
      `procedural random channel ${JSON.stringify(channel)} cannot be empty`,
    );
  }
  const source = `${seed}:${revision}:${
    coordinates.join(":")
  }:${normalized_channel}`;
  return Number(hash_text(source) >> 11n) / 2 ** 53;
}

function hash_text(source: string): bigint {
  let value = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(source)) {
    value ^= BigInt(byte);
    value = value * 0x100000001b3n & unsigned_64_maximum;
  }
  return value;
}
