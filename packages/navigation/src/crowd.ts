import type { Vec3 } from "@ink/math/vector.ts";
import {
  vec3,
  vec3_add,
  vec3_length,
  vec3_scale,
  vec3_subtract,
} from "@ink/math/vector.ts";
import type { Observer } from "@ink/observability/observer.ts";
import { navigation_agent_id, type NavigationAgentId } from "./identity.ts";
import type { NavigationSnapshot } from "./navmesh.ts";
import type { AgentProfile } from "./profile.ts";

export interface CrowdAgent {
  readonly id: NavigationAgentId;
  readonly position: Vec3;
  readonly velocity: Vec3;
  readonly path: readonly Vec3[];
  readonly profile: AgentProfile;
}

export interface CrowdDesiredVelocity {
  readonly agent: NavigationAgentId;
  readonly desired_velocity: Vec3;
  readonly target: Vec3;
  readonly neighbors: readonly NavigationAgentId[];
  readonly navigation_revision: number;
}

export interface CrowdUpdateOptions {
  readonly delta_seconds: number;
  readonly neighbor_distance: number;
  readonly obstacle_distance: number;
  readonly expected_revision?: number;
  readonly observer?: Observer;
}

export type CrowdUpdateResult =
  | {
    readonly type: "ready";
    readonly revision: number;
    readonly outputs: readonly CrowdDesiredVelocity[];
  }
  | {
    readonly type: "stale";
    readonly expected_revision: number;
    readonly current_revision: number;
  };

export function update_crowd(
  snapshot: NavigationSnapshot,
  agents: readonly CrowdAgent[],
  options: CrowdUpdateOptions,
): CrowdUpdateResult {
  if (
    options.expected_revision !== undefined &&
    options.expected_revision !== snapshot.revision
  ) {
    return {
      type: "stale",
      expected_revision: options.expected_revision,
      current_revision: snapshot.revision,
    };
  }
  for (
    const [label, value, positive] of [
      ["delta seconds", options.delta_seconds, true],
      ["neighbor distance", options.neighbor_distance, false],
      ["obstacle distance", options.obstacle_distance, false],
    ] as const
  ) {
    if (!Number.isFinite(value) || value < 0 || (positive && value === 0)) {
      throw new Error(
        `navigation crowd ${label} ${JSON.stringify(value)} must be ${
          positive ? "positive" : "nonnegative"
        } and finite`,
      );
    }
  }
  for (const agent of agents) {
    if (navigation_agent_id(agent.id) !== agent.id) {
      throw new Error(
        `navigation agent id ${JSON.stringify(agent.id)} is not canonical`,
      );
    }
  }
  const ordered = [...agents].sort((left, right) =>
    left.id.localeCompare(right.id)
  );
  const identities = new Set<NavigationAgentId>();
  for (const agent of ordered) {
    if (identities.has(agent.id)) {
      throw new Error(
        `navigation crowd repeats agent ${JSON.stringify(agent.id)}`,
      );
    }
    identities.add(agent.id);
    if (agent.path.length === 0) {
      throw new Error(
        `navigation crowd agent ${JSON.stringify(agent.id)} has an empty path`,
      );
    }
  }
  let neighbor_samples = 0;
  const outputs = Object.freeze(ordered.map((agent) => {
    const target = steering_target(agent);
    const preferred = toward(
      agent.position,
      target,
      agent.profile.maximum_speed,
    );
    const neighbors = ordered.filter((candidate) =>
      candidate.id !== agent.id &&
      horizontal_distance(candidate.position, agent.position) <=
        options.neighbor_distance
    );
    neighbor_samples += neighbors.length;
    let avoidance = vec3(0, 0, 0);
    for (const neighbor of neighbors) {
      const separation = vec3(
        agent.position.x - neighbor.position.x,
        0,
        agent.position.z - neighbor.position.z,
      );
      const distance = vec3_length(separation);
      const combined_radius = agent.profile.radius + neighbor.profile.radius;
      if (distance === 0) {
        const direction = agent.id.localeCompare(neighbor.id) < 0 ? -1 : 1;
        avoidance = vec3_add(
          avoidance,
          vec3(direction * agent.profile.maximum_speed, 0, 0),
        );
        continue;
      }
      const influence = Math.max(0, options.neighbor_distance - distance) /
        Math.max(options.neighbor_distance, 1e-9);
      const overlap = Math.max(1, combined_radius / distance);
      avoidance = vec3_add(
        avoidance,
        vec3_scale(
          separation,
          influence * overlap / distance * agent.profile.maximum_speed,
        ),
      );
    }
    for (const obstacle of snapshot.obstacles) {
      const closest = vec3(
        clamp(
          agent.position.x,
          obstacle.bounds.minimum.x,
          obstacle.bounds.maximum.x,
        ),
        agent.position.y,
        clamp(
          agent.position.z,
          obstacle.bounds.minimum.z,
          obstacle.bounds.maximum.z,
        ),
      );
      const separation = vec3_subtract(agent.position, closest);
      const distance = horizontal_distance(agent.position, closest);
      if (distance === 0) {
        avoidance = vec3_add(
          avoidance,
          inside_obstacle_avoidance(
            agent.position,
            obstacle.bounds,
            agent.profile.maximum_speed,
          ),
        );
        continue;
      }
      if (distance > options.obstacle_distance + agent.profile.radius) continue;
      const strength =
        (options.obstacle_distance + agent.profile.radius - distance) /
        Math.max(options.obstacle_distance, 1e-9);
      avoidance = vec3_add(
        avoidance,
        vec3_scale(
          separation,
          strength * agent.profile.maximum_speed / distance,
        ),
      );
    }
    const requested = clamp_length(
      vec3_add(preferred, avoidance),
      agent.profile.maximum_speed,
    );
    const change = vec3_subtract(requested, agent.velocity);
    const accelerated = vec3_add(
      agent.velocity,
      clamp_length(
        change,
        agent.profile.maximum_acceleration * options.delta_seconds,
      ),
    );
    return Object.freeze({
      agent: agent.id,
      desired_velocity: clamp_length(accelerated, agent.profile.maximum_speed),
      target,
      neighbors: Object.freeze(neighbors.map(({ id }) => id)),
      navigation_revision: snapshot.revision,
    });
  }));
  options.observer?.event("navigation.crowd.updated", {
    revision: snapshot.revision,
    agents: outputs.length,
    neighbor_samples,
  });
  return { type: "ready", revision: snapshot.revision, outputs };
}

function steering_target(agent: CrowdAgent): Vec3 {
  for (const point of agent.path) {
    if (horizontal_distance(point, agent.position) > agent.profile.radius) {
      return point;
    }
  }
  return agent.path.at(-1)!;
}

function toward(position: Vec3, target: Vec3, speed: number): Vec3 {
  const offset = vec3(target.x - position.x, 0, target.z - position.z);
  const distance = vec3_length(offset);
  return distance === 0 ? vec3(0, 0, 0) : vec3_scale(offset, speed / distance);
}

function clamp_length(value: Vec3, maximum: number): Vec3 {
  const length = vec3_length(value);
  if (length === 0 || length <= maximum) return value;
  return vec3_scale(value, maximum / length);
}

function horizontal_distance(left: Vec3, right: Vec3): number {
  return Math.hypot(left.x - right.x, left.z - right.z);
}

function inside_obstacle_avoidance(
  position: Vec3,
  bounds: NavigationSnapshot["obstacles"][number]["bounds"],
  speed: number,
): Vec3 {
  const exits = [
    { distance: position.x - bounds.minimum.x, direction: vec3(-1, 0, 0) },
    { distance: bounds.maximum.x - position.x, direction: vec3(1, 0, 0) },
    { distance: position.z - bounds.minimum.z, direction: vec3(0, 0, -1) },
    { distance: bounds.maximum.z - position.z, direction: vec3(0, 0, 1) },
  ];
  exits.sort((left, right) => left.distance - right.distance);
  return vec3_scale(exits[0].direction, speed);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
