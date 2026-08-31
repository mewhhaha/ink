import { vec2, vec3 } from "@ink/math/vector.ts";
import { noise_seed, type NoiseSeed } from "@ink/noise/domain.ts";
import { hash_u32 } from "@ink/noise/hash.ts";
import { value_noise_2d } from "@ink/noise/value.ts";
import {
  generator_revision,
  procedural_seed,
} from "@ink/procedural/identity.ts";
import { procedural_recipe } from "@ink/procedural/recipe.ts";
import { scatter_points } from "@ink/procedural/scatter.ts";
import type {
  StrategyObjective,
  StrategyPoint,
  StrategyProject,
  StrategyRoute,
  StrategyStructure,
} from "@ink/strategy-editor/model.ts";
import {
  parse_strategy_project,
  serialize_strategy_project,
} from "@ink/strategy-editor/serialization.ts";
import { global_position, world_id } from "@ink/world/identity.ts";
import {
  create_terrain,
  sample_terrain,
  type TerrainDescriptor,
} from "@ink/world/terrain.ts";
import { place_vegetation } from "@ink/world/vegetation.ts";

const fixed_unit = 1_000_000;
const terrain_spacing = 4;
const maximum_vegetation = 12;
const maximum_scatter = 8;

export interface StrategyRouteContent {
  readonly id: string;
  readonly order: number;
  readonly x: number;
  readonly z: number;
  readonly travel_seconds: number;
}

export interface StrategyTerrainContent {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly surface: number;
}

export interface StrategySceneryContent {
  readonly id: number;
  readonly source_id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly scale: number;
}

export interface StrategyGeneratedContent {
  readonly seed: number;
  readonly world_id: string;
  readonly has_barracks: boolean;
  readonly route: readonly StrategyRouteContent[];
  readonly terrain: readonly StrategyTerrainContent[];
  readonly vegetation: readonly StrategySceneryContent[];
  readonly scatter: readonly StrategySceneryContent[];
}

export interface CompiledStrategyProject {
  readonly blot_source: string;
  readonly canonical_source: string;
  readonly content: StrategyGeneratedContent;
}

interface StrategyGameContract {
  readonly project: StrategyProject;
  readonly player_headquarters: StrategyStructure;
  readonly opponent_headquarters: StrategyStructure;
  readonly barracks:
    | Extract<StrategyStructure, { readonly kind: "barracks" }>
    | undefined;
  readonly route: StrategyRoute;
  readonly objective: StrategyObjective;
}

export function compile_strategy_project(
  source: string,
): CompiledStrategyProject {
  const project = parse_strategy_project(source);
  const contract = strategy_game_contract(project);
  const seed = content_seed(project, contract.route);
  const terrain = generated_terrain(project, seed);
  const content = generated_content(contract, seed, terrain);
  return Object.freeze({
    blot_source: compile_blot_project(contract, content),
    canonical_source: serialize_strategy_project(project),
    content,
  });
}

function strategy_game_contract(
  project: StrategyProject,
): StrategyGameContract {
  const player = required_one(
    project.factions.filter(({ relation }) => relation === "player"),
    `strategy project ${project.id} player faction`,
  );
  const opponent = required_one(
    project.factions.filter(({ relation }) => relation === "opponent"),
    `strategy project ${project.id} opponent faction`,
  );
  const player_headquarters = required_one(
    project.structures.filter((structure) =>
      structure.kind === "headquarters" &&
      structure.faction_id === player.id
    ),
    `strategy project ${project.id} player headquarters`,
  );
  const opponent_headquarters = required_one(
    project.structures.filter((structure) =>
      structure.kind === "headquarters" &&
      structure.faction_id === opponent.id
    ),
    `strategy project ${project.id} opponent headquarters`,
  );
  const barracks = optional_one(
    project.structures.filter((structure): structure is Extract<
      StrategyStructure,
      { readonly kind: "barracks" }
    > =>
      structure.kind === "barracks" &&
      structure.faction_id === player.id &&
      structure.produces_unit_id === "scout"
    ),
    `strategy project ${project.id} player scout barracks`,
  );
  const route = project.routes.find(({ id }) => id === "scout-route") ??
    required_one(
      project.routes.filter(({ id }) => id === "route-main"),
      `strategy project ${project.id} fallback route`,
    );
  const objective = required_one(
    project.objectives.filter(({ condition }) =>
      condition.type === "destroy_structure" &&
      condition.structure_id === opponent_headquarters.id
    ),
    `strategy project ${project.id} opposing headquarters objective`,
  );
  if (route.points.length > 8) {
    throw new Error(
      `strategy route ${route.id} has ${route.points.length} points; at most 8 are supported`,
    );
  }
  if (
    barracks !== undefined &&
    !same_point(route.points[0], barracks.position)
  ) {
    throw new Error(
      `strategy route ${route.id} must start at barracks ${barracks.id}`,
    );
  }
  if (
    barracks !== undefined &&
    !same_point(route.points.at(-1), opponent_headquarters.position)
  ) {
    throw new Error(
      `strategy route ${route.id} must end at headquarters ${opponent_headquarters.id}`,
    );
  }
  return Object.freeze({
    project,
    player_headquarters,
    opponent_headquarters,
    barracks,
    route,
    objective,
  });
}

function generated_terrain(
  project: StrategyProject,
  seed: NoiseSeed,
): TerrainDescriptor {
  if (
    project.map.width % terrain_spacing !== 0 ||
    project.map.height % terrain_spacing !== 0
  ) {
    throw new Error(
      `strategy map ${project.map.width}x${project.map.height} must align to ${terrain_spacing}-meter terrain`,
    );
  }
  const width = project.map.width / terrain_spacing + 1;
  const depth = project.map.height / terrain_spacing + 1;
  const heights = new Float32Array(width * depth);
  const surfaces = new Uint16Array(width * depth);
  for (let z = 0; z < depth; z += 1) {
    for (let x = 0; x < width; x += 1) {
      const sample = value_noise_2d({
        position: vec2(x * 0.42, z * 0.42),
        seed,
      });
      const index = z * width + x;
      heights[index] = sample * 0.65;
      surfaces[index] = sample > 0.08 ? 1 : 0;
    }
  }
  return create_terrain({
    origin: global_position(0, 0, vec3(0, 0, 0), 64),
    width,
    depth,
    spacing: terrain_spacing,
    heights,
    surfaces,
    regions: [{
      id: "frontier",
      minimum_x: 0,
      minimum_z: 0,
      maximum_x: width - 1,
      maximum_z: depth - 1,
    }],
  });
}

function generated_content(
  contract: StrategyGameContract,
  seed: NoiseSeed,
  terrain: TerrainDescriptor,
): StrategyGeneratedContent {
  const route = route_content(contract.route, terrain);
  const terrain_tiles: StrategyTerrainContent[] = [];
  for (let z = 0; z < terrain.depth - 1; z += 1) {
    for (let x = 0; x < terrain.width - 1; x += 1) {
      const world_x = (x + 0.5) * terrain.spacing;
      const world_z = (z + 0.5) * terrain.spacing;
      const sample = required_terrain_sample(terrain, world_x, world_z);
      terrain_tiles.push(Object.freeze({
        id: 1_000 + z * (terrain.width - 1) + x,
        x: world_x,
        y: sample.height,
        z: world_z,
        surface: sample.surface,
      }));
    }
  }

  const exclusions = new Uint8Array(terrain.width * terrain.depth);
  for (const point of contract.route.points) {
    const x = Math.round(point.x / terrain.spacing);
    const z = Math.round(point.y / terrain.spacing);
    exclusions[z * terrain.width + x] = 1;
  }
  const vegetation = place_vegetation({
    seed: BigInt(seed),
    generator_version: "strategy-v1",
    region_revision: contract.route.points.length,
    terrain,
    spacing: 3,
    density: new Float32Array(terrain.width * terrain.depth).fill(0.86),
    exclusions,
    species: [{
      id: "frontier-pine",
      weight: 1,
      minimum_scale: 0.72,
      maximum_scale: 1.25,
    }],
    maximum_instances: maximum_vegetation,
  }).map((instance, index) =>
    Object.freeze({
      id: 2_000 + index,
      source_id: instance.id,
      x: instance.position.x,
      y: instance.position.y,
      z: instance.position.z,
      scale: instance.scale,
    })
  );

  const procedural_seed_value = procedural_seed(BigInt(seed));
  const revision = generator_revision(
    `strategy-${contract.project.map.width}x${contract.project.map.height}-${contract.route.id}`,
  );
  const recipe = procedural_recipe({
    seed: procedural_seed_value,
    revision,
    scatter: {
      minimum_x: 0,
      minimum_z: 0,
      maximum_x: contract.project.map.width,
      maximum_z: contract.project.map.height,
      spacing: 3.5,
      maximum_points: maximum_scatter,
      density: {
        sample(x, z) {
          if (distance_to_route_squared(contract.route, x, z) < 4) return 0;
          const amount = value_noise_2d({
            position: vec2(x / 7, z / 7),
            seed,
          });
          return Math.min(1, Math.max(0, 0.68 + amount * 0.2));
        },
      },
    },
  });
  const scatter = scatter_points(recipe.scatter).map((point, index) => {
    const terrain_sample = required_terrain_sample(
      terrain,
      point.position.x,
      point.position.y,
    );
    return Object.freeze({
      id: 3_000 + index,
      source_id: point.id,
      x: point.position.x,
      y: terrain_sample.height,
      z: point.position.y,
      scale: point.scale,
    });
  });
  return Object.freeze({
    seed: Number(seed),
    world_id: world_id(contract.project.id),
    has_barracks: contract.barracks !== undefined,
    route: Object.freeze(route),
    terrain: Object.freeze(terrain_tiles),
    vegetation: Object.freeze(vegetation),
    scatter: Object.freeze(scatter),
  });
}

function route_content(
  route: StrategyRoute,
  terrain: TerrainDescriptor,
): readonly StrategyRouteContent[] {
  let previous = route.points[0];
  let previous_height = required_terrain_sample(
    terrain,
    previous.x,
    previous.y,
  ).height;
  return route.points.map((point, index) => {
    const height = required_terrain_sample(terrain, point.x, point.y).height;
    const distance = Math.hypot(point.x - previous.x, point.y - previous.y);
    const travel_seconds = Math.max(
      1,
      Math.round(distance / 3 + Math.abs(height - previous_height) * 2),
    );
    previous = point;
    previous_height = height;
    return Object.freeze({
      id: `${route.id}-point-${index + 1}`,
      order: index + 1,
      x: point.x,
      z: point.y,
      travel_seconds,
    });
  });
}

function required_terrain_sample(
  terrain: TerrainDescriptor,
  x: number,
  z: number,
) {
  const sample = sample_terrain(terrain, x, z);
  if (sample.type === "outside") {
    throw new Error(
      `strategy terrain omitted authored coordinate (${x}, ${z})`,
    );
  }
  return sample;
}

function content_seed(
  project: StrategyProject,
  route: StrategyRoute,
): NoiseSeed {
  let seed = noise_seed(
    Math.imul(project.map.width, 65_537) + project.map.height >>> 0,
  );
  seed = noise_seed(hash_u32(seed, project.map.width, project.map.height));
  for (const [index, point] of route.points.entries()) {
    seed = noise_seed(hash_u32(
      seed,
      safe_integer(point.x, `strategy route ${route.id} point ${index} x`),
      safe_integer(point.y, `strategy route ${route.id} point ${index} y`),
      index,
    ));
  }
  return seed;
}

function compile_blot_project(
  contract: StrategyGameContract,
  content: StrategyGeneratedContent,
): string {
  const barracks_position = contract.barracks?.position ??
    contract.player_headquarters.position;
  return `open import "blot:prelude"

const StrategyRoutePoint = {
  .id = Text;
  .order = Int;
  .x = Int;
  .z = Int;
  .travel_seconds = Int;
}

const StrategyTerrainTile = {
  .id = Int;
  .surface = Int;
  .x = Int;
  .y = Int;
  .z = Int;
}

const StrategySceneryInstance = {
  .id = Int;
  .source_id = Text;
  .x = Int;
  .y = Int;
  .z = Int;
  .scale = Int;
}

const StrategyProject = {
  .runtime_token = Int;
  .project_name = Text;
  .world_id = Text;
  .objective_text = Text;
  .has_barracks = Int;
  .barracks_id = Text;
  .barracks_x = Int;
  .barracks_z = Int;
  .player_hq_x = Int;
  .player_hq_z = Int;
  .opponent_hq_x = Int;
  .opponent_hq_z = Int;
  .seed = Int;
  .enemy_health = Int;
  .route = [StrategyRoutePoint];
  .terrain = [StrategyTerrainTile];
  .vegetation = [StrategySceneryInstance];
  .scatter = [StrategySceneryInstance];
}

const project :: Int -> StrategyProject
const project = fn runtime_token => {
  .runtime_token = runtime_token;
  .project_name = ${blot_text_literal(contract.project.name)};
  .world_id = ${blot_text_literal(content.world_id)};
  .objective_text = ${blot_text_literal(contract.objective.text)};
  .has_barracks = ${content.has_barracks ? 1 : 0};
  .barracks_id = ${blot_text_literal(contract.barracks?.id ?? "unbuilt")};
  .barracks_x = ${fixed(barracks_position.x, "barracks x")};
  .barracks_z = ${fixed(barracks_position.y, "barracks z")};
  .player_hq_x = ${
    fixed(contract.player_headquarters.position.x, "player headquarters x")
  };
  .player_hq_z = ${
    fixed(contract.player_headquarters.position.y, "player headquarters z")
  };
  .opponent_hq_x = ${
    fixed(contract.opponent_headquarters.position.x, "opponent headquarters x")
  };
  .opponent_hq_z = ${
    fixed(contract.opponent_headquarters.position.y, "opponent headquarters z")
  };
  .seed = ${content.seed};
  .enemy_health = 3;
  .route = ${
    blot_array(content.route, (point) =>
      `{
    .id = ${blot_text_literal(point.id)};
    .order = ${point.order};
    .x = ${fixed(point.x, `route ${point.id} x`)};
    .z = ${fixed(point.z, `route ${point.id} z`)};
    .travel_seconds = ${point.travel_seconds};
  }`)
  };
  .terrain = ${
    blot_array(content.terrain, (tile) =>
      `{
    .id = ${tile.id};
    .surface = ${tile.surface};
    .x = ${fixed(tile.x, `terrain ${tile.id} x`)};
    .y = ${fixed(tile.y, `terrain ${tile.id} y`)};
    .z = ${fixed(tile.z, `terrain ${tile.id} z`)};
  }`)
  };
  .vegetation = ${
    blot_array(content.vegetation, (instance) =>
      `{
    .id = ${instance.id};
    .source_id = ${blot_text_literal(instance.source_id)};
    .x = ${fixed(instance.x, `vegetation ${instance.id} x`)};
    .y = ${fixed(instance.y, `vegetation ${instance.id} y`)};
    .z = ${fixed(instance.z, `vegetation ${instance.id} z`)};
    .scale = ${fixed(instance.scale, `vegetation ${instance.id} scale`)};
  }`)
  };
  .scatter = ${
    blot_array(content.scatter, (instance) =>
      `{
    .id = ${instance.id};
    .source_id = ${blot_text_literal(instance.source_id)};
    .x = ${fixed(instance.x, `scatter ${instance.id} x`)};
    .y = ${fixed(instance.y, `scatter ${instance.id} y`)};
    .z = ${fixed(instance.z, `scatter ${instance.id} z`)};
    .scale = ${fixed(instance.scale, `scatter ${instance.id} scale`)};
  }`)
  };
}

return { .project = project; }
`;
}

function blot_array<Entry>(
  entries: readonly Entry[],
  serialize: (entry: Entry) => string,
): string {
  return `[${entries.map(serialize).join(", ")}]`;
}

function distance_to_route_squared(
  route: StrategyRoute,
  x: number,
  z: number,
): number {
  return route.points.reduce(
    (minimum, point) =>
      Math.min(minimum, (point.x - x) ** 2 + (point.y - z) ** 2),
    Number.POSITIVE_INFINITY,
  );
}

function optional_one<Entry>(
  entries: readonly Entry[],
  label: string,
): Entry | undefined {
  if (entries.length > 1) {
    throw new Error(`${label} count ${entries.length} must be at most 1`);
  }
  return entries[0];
}

function required_one<Entry>(entries: readonly Entry[], label: string): Entry {
  if (entries.length !== 1) {
    throw new Error(`${label} count ${entries.length} must be 1`);
  }
  return entries[0];
}

function same_point(
  left: StrategyPoint | undefined,
  right: StrategyPoint,
): boolean {
  return left?.x === right.x && left.y === right.y;
}

function safe_integer(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} ${value} must be a safe integer`);
  }
  return value;
}

function fixed(value: number, label: string): number {
  const scaled = Math.round(value * fixed_unit);
  if (!Number.isSafeInteger(scaled)) {
    throw new Error(`${label} ${value} exceeds Blot fixed-point range`);
  }
  return scaled;
}

function blot_text_literal(value: string): string {
  return JSON.stringify(value)
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
