import type { Vec3 } from "@ink/math/vector.ts";

export interface ParticleMotionQuery {
  readonly start: Vec3;
  readonly finish: Vec3;
  readonly radius: number;
  readonly stable_sequence: number;
}

export interface ParticleContact {
  readonly position: Vec3;
  readonly normal: Vec3;
  readonly distance: number;
}

export interface DepthCollisionPort {
  readonly source: "depth";
  query(motion: ParticleMotionQuery): ParticleContact | undefined;
}

export interface TerrainCollisionPort {
  readonly source: "terrain";
  query(motion: ParticleMotionQuery): ParticleContact | undefined;
}

export interface WorldCollisionPort {
  readonly source: "world";
  query(motion: ParticleMotionQuery): ParticleContact | undefined;
}

export interface CollisionPorts {
  readonly depth?: DepthCollisionPort;
  readonly terrain?: TerrainCollisionPort;
  readonly world?: WorldCollisionPort;
}

export type CollisionPort =
  | DepthCollisionPort
  | TerrainCollisionPort
  | WorldCollisionPort;

export function collision_port(
  ports: CollisionPorts | undefined,
  source: CollisionPort["source"],
): CollisionPort | undefined {
  return ports?.[source];
}
