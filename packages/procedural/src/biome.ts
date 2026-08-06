import { finite_number } from "@ink/math/scalar.ts";

export interface BiomeRange {
  readonly minimum: number;
  readonly maximum: number;
  readonly falloff?: number;
}

export interface BiomeDefinition {
  readonly id: string;
  readonly priority?: number;
  readonly elevation: BiomeRange;
  readonly moisture: BiomeRange;
  readonly temperature: BiomeRange;
  readonly surface: number;
}

export interface BiomeSample {
  readonly elevation: number;
  readonly moisture: number;
  readonly temperature: number;
}

export interface BiomeSelection {
  readonly biome: string;
  readonly surface: number;
  readonly suitability: number;
}

export function select_biome(
  definitions: readonly BiomeDefinition[],
  sample: BiomeSample,
): BiomeSelection {
  const parsed = parse_definitions(definitions);
  const elevation = finite_number(sample.elevation, "biome elevation");
  const moisture = finite_number(sample.moisture, "biome moisture");
  const temperature = finite_number(sample.temperature, "biome temperature");
  const ranked = parsed.map((definition) => ({
    definition,
    suitability: range_weight(definition.elevation, elevation) *
      range_weight(definition.moisture, moisture) *
      range_weight(definition.temperature, temperature),
  })).sort((left, right) =>
    right.suitability - left.suitability ||
    right.definition.priority - left.definition.priority ||
    left.definition.id.localeCompare(right.definition.id)
  );
  const selection = ranked[0];
  if (selection.suitability <= 0) {
    throw new Error(
      `no biome accepts elevation=${elevation} moisture=${moisture} temperature=${temperature}`,
    );
  }
  return Object.freeze({
    biome: selection.definition.id,
    surface: selection.definition.surface,
    suitability: selection.suitability,
  });
}

export function bake_biome_surfaces(
  definitions: readonly BiomeDefinition[],
  samples: readonly BiomeSample[],
): Uint16Array {
  const surfaces = new Uint16Array(samples.length);
  for (const [index, sample] of samples.entries()) {
    surfaces[index] = select_biome(definitions, sample).surface;
  }
  return surfaces;
}

interface ParsedBiomeDefinition {
  readonly id: string;
  readonly priority: number;
  readonly elevation: Required<BiomeRange>;
  readonly moisture: Required<BiomeRange>;
  readonly temperature: Required<BiomeRange>;
  readonly surface: number;
}

function parse_definitions(
  definitions: readonly BiomeDefinition[],
): readonly ParsedBiomeDefinition[] {
  if (definitions.length === 0) throw new Error("biomes cannot be empty");
  const identities = new Set<string>();
  return definitions.map((definition, index) => {
    const id = definition.id.trim();
    if (id.length === 0 || identities.has(id)) {
      throw new Error(
        `biome ${index} id ${
          JSON.stringify(definition.id)
        } is empty or duplicated`,
      );
    }
    identities.add(id);
    if (
      !Number.isSafeInteger(definition.surface) || definition.surface < 0 ||
      definition.surface > 0xffff
    ) {
      throw new Error(
        `biome ${
          JSON.stringify(id)
        } surface ${definition.surface} must be an unsigned 16-bit integer`,
      );
    }
    return Object.freeze({
      id,
      priority: safe_integer(definition.priority ?? 0, `biome ${id} priority`),
      elevation: parse_range(definition.elevation, `biome ${id} elevation`),
      moisture: parse_range(definition.moisture, `biome ${id} moisture`),
      temperature: parse_range(
        definition.temperature,
        `biome ${id} temperature`,
      ),
      surface: definition.surface,
    });
  });
}

function parse_range(range: BiomeRange, label: string): Required<BiomeRange> {
  const minimum = finite_number(range.minimum, `${label} minimum`);
  const maximum = finite_number(range.maximum, `${label} maximum`);
  const falloff = finite_number(range.falloff ?? 0, `${label} falloff`);
  if (minimum > maximum) throw new Error(`${label} minimum exceeds maximum`);
  if (falloff < 0) {
    throw new Error(`${label} falloff ${falloff} must be nonnegative`);
  }
  return Object.freeze({ minimum, maximum, falloff });
}

function range_weight(range: Required<BiomeRange>, value: number): number {
  if (value >= range.minimum && value <= range.maximum) return 1;
  if (range.falloff === 0) return 0;
  const distance = value < range.minimum
    ? range.minimum - value
    : value - range.maximum;
  return Math.max(0, 1 - distance / range.falloff);
}

function safe_integer(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} ${value} must be a safe integer`);
  }
  return value;
}
