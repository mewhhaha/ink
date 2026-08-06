import { mesh_topology } from "@ink/geometry/mesh.ts";
import type { Aabb } from "@ink/geometry/shapes.ts";
import { vec3, vec3_scale } from "@ink/math/vector.ts";
import type { Vec3 } from "@ink/math/vector.ts";
import {
  compose_rigid_pose,
  shape_world_bounds,
} from "@ink/physics/collision.ts";
import type { BodyId, ShapeId } from "@ink/physics/identity.ts";
import { physics_id_key } from "@ink/physics/identity.ts";
import type {
  CharacterMoveResult,
  MotionType,
  PhysicsQueryFilter,
} from "@ink/physics/world.ts";
import { PhysicsWorld } from "@ink/physics/world.ts";
import type {
  CellId,
  ChunkCoordinate,
  LocalOrigin,
} from "@ink/world/identity.ts";
import { global_to_local } from "@ink/world/identity.ts";
import type { OriginShiftAdapter } from "@ink/world/origin.ts";
import type { PartitionCell } from "@ink/world/partition.ts";
import type { CellScenePublisher } from "@ink/world/streaming.ts";
import type { TerrainDescriptor } from "@ink/world/terrain.ts";
import type { CrowdDesiredVelocity } from "./crowd.ts";
import {
  navigation_obstacle_id,
  type NavigationAreaId,
  type NavigationTileId,
} from "./identity.ts";
import { NavigationMesh } from "./navmesh.ts";
import type { AgentProfile } from "./profile.ts";
import {
  build_navigation_tile,
  type NavigationObstacle,
  type NavigationTileInput,
} from "./tile.ts";

export type NavigationSceneSnapshot = Parameters<
  CellScenePublisher["publish"]
>[1];

export interface SceneNavigationGeometrySource {
  extract(
    cell: PartitionCell,
    snapshot: NavigationSceneSnapshot,
  ): readonly NavigationTileInput[] | Promise<readonly NavigationTileInput[]>;
}

interface PublishedNavigationCell {
  readonly scene_revision: number;
  readonly tiles: readonly NavigationTileId[];
}

export class WorldNavigationPublisher implements CellScenePublisher {
  readonly #mesh: NavigationMesh;
  readonly #profile: AgentProfile;
  readonly #source: SceneNavigationGeometrySource;
  readonly #published = new Map<CellId, PublishedNavigationCell>();

  constructor(options: {
    readonly mesh: NavigationMesh;
    readonly profile: AgentProfile;
    readonly source: SceneNavigationGeometrySource;
  }) {
    this.#mesh = options.mesh;
    this.#profile = options.profile;
    this.#source = options.source;
  }

  async publish(
    cell: PartitionCell,
    snapshot: NavigationSceneSnapshot,
  ): Promise<void> {
    const sources = [...await this.#source.extract(cell, snapshot)].sort((
      left,
      right,
    ) => left.id.localeCompare(right.id));
    const tiles = sources.map((source) => {
      const result = build_navigation_tile(source, this.#profile);
      if (result.type !== "ready") {
        throw new Error(
          `navigation cell ${JSON.stringify(cell.id)} tile ${
            JSON.stringify(source.id)
          } build failed: ${
            result.type === "malformed_geometry" ? result.reason : "cancelled"
          }`,
        );
      }
      return result.tile;
    });
    const previous = this.#published.get(cell.id);
    const changed = this.#mesh.replace_tiles(previous?.tiles ?? [], tiles);
    if (changed.type === "failed") {
      throw new Error(
        `navigation cell ${
          JSON.stringify(cell.id)
        } publication failed: ${changed.reason}`,
      );
    }
    this.#published.set(
      cell.id,
      Object.freeze({
        scene_revision: snapshot.revision,
        tiles: Object.freeze(tiles.map(({ id }) => id)),
      }),
    );
  }

  detach(cell: PartitionCell, snapshot: NavigationSceneSnapshot): void {
    const published = this.#published.get(cell.id);
    if (
      published === undefined || published.scene_revision !== snapshot.revision
    ) return;
    const changed = this.#mesh.replace_tiles(published.tiles, []);
    if (changed.type === "failed") {
      throw new Error(
        `navigation cell ${
          JSON.stringify(cell.id)
        } detachment failed: ${changed.reason}`,
      );
    }
    this.#published.delete(cell.id);
  }
}

export function navigation_tile_input_from_terrain(
  terrain: TerrainDescriptor,
  coordinate: ChunkCoordinate,
  options: {
    readonly id: NavigationTileId;
    readonly chunk_quads: number;
    readonly cell_height: number;
    readonly area: NavigationAreaId;
    readonly local_origin: LocalOrigin;
    readonly world_cell_size: number;
  },
): NavigationTileInput {
  if (!Number.isSafeInteger(options.chunk_quads) || options.chunk_quads <= 0) {
    throw new Error(
      `navigation terrain chunk quads ${
        JSON.stringify(options.chunk_quads)
      } must be a positive safe integer`,
    );
  }
  const start_x = coordinate.x * options.chunk_quads;
  const start_z = coordinate.z * options.chunk_quads;
  if (
    start_x < 0 || start_z < 0 ||
    start_x + options.chunk_quads >= terrain.width ||
    start_z + options.chunk_quads >= terrain.depth
  ) {
    throw new Error(
      `navigation terrain tile ${
        JSON.stringify(options.id)
      } chunk (${coordinate.x}, ${coordinate.z}) is outside ${terrain.width}x${terrain.depth}`,
    );
  }
  const terrain_offset = global_to_local(
    terrain.origin,
    options.local_origin,
    options.world_cell_size,
  );
  const positions: Vec3[] = [];
  const samples = options.chunk_quads + 1;
  for (let row = 0; row < samples; row += 1) {
    for (let column = 0; column < samples; column += 1) {
      const x = start_x + column;
      const z = start_z + row;
      positions.push(vec3(
        terrain_offset.x + x * terrain.spacing,
        terrain_offset.y + terrain.heights[z * terrain.width + x],
        terrain_offset.z + z * terrain.spacing,
      ));
    }
  }
  const indices: number[] = [];
  for (let row = 0; row < options.chunk_quads; row += 1) {
    for (let column = 0; column < options.chunk_quads; column += 1) {
      const terrain_x = start_x + column;
      const terrain_z = start_z + row;
      if (terrain.holes[terrain_z * (terrain.width - 1) + terrain_x] === 1) {
        continue;
      }
      const north_west = row * samples + column;
      const north_east = north_west + 1;
      const south_west = north_west + samples;
      const south_east = south_west + 1;
      indices.push(
        north_west,
        south_west,
        north_east,
        north_east,
        south_west,
        south_east,
      );
    }
  }
  if (indices.length === 0) {
    throw new Error(
      `navigation terrain tile ${
        JSON.stringify(options.id)
      } contains no traversable triangles`,
    );
  }
  return Object.freeze({
    id: options.id,
    coordinate,
    source_revision: terrain.revision,
    origin: vec3(
      terrain_offset.x + start_x * terrain.spacing,
      terrain_offset.y,
      terrain_offset.z + start_z * terrain.spacing,
    ),
    width: options.chunk_quads,
    depth: options.chunk_quads,
    cell_size: terrain.spacing,
    cell_height: options.cell_height,
    geometry: Object.freeze([mesh_topology(positions, indices)]),
    default_area: options.area,
  });
}

export function navigation_origin_shift_adapter(
  mesh: NavigationMesh,
): OriginShiftAdapter {
  return {
    id: "navigation",
    stage(event) {
      return mesh.stage_rebase(event.local_translation);
    },
  };
}

export function navigation_obstacles_from_physics(
  world: PhysicsWorld,
  options: {
    readonly motions: readonly MotionType[];
    readonly include_sensors: boolean;
  },
): readonly NavigationObstacle[] {
  const snapshot = world.snapshot();
  const motions = new Set(options.motions);
  const shapes = new Map(
    snapshot.shapes.map((entry) => [physics_id_key(entry.id), entry.shape]),
  );
  const bodies = new Map(
    snapshot.bodies.map((entry) => [physics_id_key(entry.id), entry]),
  );
  const obstacles: NavigationObstacle[] = [];
  for (const collider of snapshot.colliders) {
    const body = bodies.get(physics_id_key(collider.body));
    const shape = shapes.get(physics_id_key(collider.shape));
    if (
      body === undefined || shape === undefined || !motions.has(body.motion) ||
      (!options.include_sensors && collider.sensor)
    ) continue;
    obstacles.push(Object.freeze({
      id: navigation_obstacle_id(`physics:${physics_id_key(collider.id)}`),
      revision: snapshot.tick,
      bounds: shape_world_bounds(
        shape,
        compose_rigid_pose(body.pose, collider.local_pose),
      ),
    }));
  }
  return Object.freeze(
    obstacles.sort((left, right) => left.id.localeCompare(right.id)),
  );
}

export interface NavigationCharacterBinding {
  readonly agent: CrowdDesiredVelocity["agent"];
  readonly body: BodyId;
  readonly shape: ShapeId;
}

export interface NavigationCharacterProposal {
  readonly agent: CrowdDesiredVelocity["agent"];
  readonly body: BodyId;
  readonly desired_velocity: Vec3;
  readonly movement: CharacterMoveResult;
}

export function evaluate_navigation_characters(
  world: PhysicsWorld,
  outputs: readonly CrowdDesiredVelocity[],
  bindings: readonly NavigationCharacterBinding[],
  options: {
    readonly delta_seconds: number;
    readonly step_height: number;
    readonly maximum_slope_radians: number;
    readonly skin: number;
    readonly filter?: PhysicsQueryFilter;
  },
): readonly NavigationCharacterProposal[] {
  if (!Number.isFinite(options.delta_seconds) || options.delta_seconds <= 0) {
    throw new Error(
      `navigation character delta seconds ${
        JSON.stringify(options.delta_seconds)
      } must be positive and finite`,
    );
  }
  const by_agent = new Map(outputs.map((output) => [output.agent, output]));
  const proposals: NavigationCharacterProposal[] = [];
  for (
    const binding of [...bindings].sort((left, right) =>
      left.agent.localeCompare(right.agent)
    )
  ) {
    const output = by_agent.get(binding.agent);
    const body = world.body_state(binding.body);
    if (output === undefined || body === null) continue;
    const movement = world.move_character({
      shape: binding.shape,
      pose: body.pose,
      displacement: vec3_scale(output.desired_velocity, options.delta_seconds),
      step_height: options.step_height,
      maximum_slope_radians: options.maximum_slope_radians,
      skin: options.skin,
      ...(options.filter === undefined ? {} : { filter: options.filter }),
    });
    proposals.push(Object.freeze({
      agent: binding.agent,
      body: binding.body,
      desired_velocity: output.desired_velocity,
      movement,
    }));
  }
  return Object.freeze(proposals);
}

export function navigation_obstacle(
  id: NavigationObstacle["id"],
  revision: number,
  bounds: Aabb,
): NavigationObstacle {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error(
      `navigation obstacle ${JSON.stringify(id)} revision ${
        JSON.stringify(revision)
      } must be a nonnegative safe integer`,
    );
  }
  return Object.freeze({ id, revision, bounds });
}
