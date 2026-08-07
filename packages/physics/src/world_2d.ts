import { ray } from "@ink/geometry/shapes.ts";
import { finite_number } from "@ink/math/scalar.ts";
import type { Vec2 } from "@ink/math/vector.ts";
import { vec2, vec3 } from "@ink/math/vector.ts";
import { quat_from_axis_angle } from "@ink/math/quaternion.ts";
import { rigid_pose } from "./collision.ts";
import {
  type BodyId,
  type ColliderId,
  physics_id_key,
  type ShapeId,
} from "./identity.ts";
import { box_shape, sphere_shape } from "./shapes.ts";
import {
  type CollisionFilter,
  type ContactEvent,
  type PhysicsChangeResult,
  type PhysicsMutationResult,
  type PhysicsQueryFilter,
  PhysicsWorld,
  type PhysicsWorldOptions,
} from "./world.ts";

export type CollisionShape2d = CircleShape2d | BoxShape2d;

export interface CircleShape2d {
  readonly type: "circle";
  readonly radius: number;
}

export interface BoxShape2d {
  readonly type: "box";
  readonly half_extents: Vec2;
}

export interface CollisionPose2d {
  readonly position: Vec2;
  readonly rotation_radians?: number;
}

export interface CollisionObject2dOptions extends CollisionPose2d {
  readonly shape: ShapeId;
  readonly filter?: CollisionFilter;
}

export interface CollisionQueryFilter2d {
  readonly mask?: number;
  readonly ignored_collisions?: readonly ColliderId[];
  readonly include_areas?: boolean;
}

export interface CollisionHit2d {
  readonly collision: ColliderId;
  readonly distance: number;
  readonly point: Vec2;
  readonly normal: Vec2;
}

export interface CollisionContact2d {
  readonly first: ColliderId;
  readonly second: ColliderId;
}

export interface AreaEvent2d {
  readonly type: "entered" | "stayed" | "exited";
  readonly area: ColliderId;
  readonly other: ColliderId;
}

export interface CollisionStep2d {
  readonly tick: number;
  readonly collisions: readonly CollisionContact2d[];
  readonly areas: readonly AreaEvent2d[];
}

export type CollisionWorld2dOptions = Pick<
  PhysicsWorldOptions,
  "id" | "fixed_step_seconds" | "broadphase_margin" | "observer"
>;

export function circle_shape_2d(radius: number): CircleShape2d {
  return Object.freeze({ type: "circle", radius: sphere_shape(radius).radius });
}

export function box_shape_2d(half_extents: Vec2): BoxShape2d {
  if (
    !Number.isFinite(half_extents.x) || !Number.isFinite(half_extents.y) ||
    half_extents.x <= 0 || half_extents.y <= 0
  ) {
    throw new Error(
      `2D box half-extents (${half_extents.x}, ${half_extents.y}) must be positive`,
    );
  }
  return Object.freeze({
    type: "box",
    half_extents: vec2(half_extents.x, half_extents.y),
  });
}

export class CollisionWorld2d {
  readonly #world: PhysicsWorld;
  readonly #bodies = new Map<string, BodyId>();
  readonly #areas = new Set<string>();

  constructor(options: CollisionWorld2dOptions) {
    this.#world = new PhysicsWorld({
      ...options,
      gravity: vec3(0, 0, 0),
    });
  }

  get tick(): number {
    return this.#world.tick;
  }

  create_shape(shape: CollisionShape2d): PhysicsMutationResult<ShapeId> {
    if (shape.type === "circle") {
      return this.#world.create_shape(sphere_shape(shape.radius));
    }
    if (shape.type === "box") {
      return this.#world.create_shape(
        box_shape(vec3(shape.half_extents.x, shape.half_extents.y, 0.5)),
      );
    }
    throw new Error(
      `2D collision shape type ${
        JSON.stringify((shape as { readonly type?: unknown }).type)
      } is unsupported`,
    );
  }

  destroy_shape(shape: ShapeId): PhysicsChangeResult {
    return this.#world.destroy_shape(shape);
  }

  create_collision(
    options: CollisionObject2dOptions,
  ): PhysicsMutationResult<ColliderId> {
    return this.#create_object(options, "collision");
  }

  create_area(
    options: CollisionObject2dOptions,
  ): PhysicsMutationResult<ColliderId> {
    return this.#create_object(options, "area");
  }

  set_pose(
    collision: ColliderId,
    pose: CollisionPose2d,
  ): PhysicsChangeResult {
    const body = this.#bodies.get(physics_id_key(collision));
    if (body === undefined) {
      return {
        type: "failed",
        reason: `2D collision ${physics_id_key(collision)} is missing or stale`,
      };
    }
    return this.#world.set_kinematic_pose(body, pose_3d(pose));
  }

  destroy_collision(collision: ColliderId): PhysicsChangeResult {
    return this.#destroy_object(collision, "collision");
  }

  destroy_area(area: ColliderId): PhysicsChangeResult {
    return this.#destroy_object(area, "area");
  }

  #destroy_object(
    collision: ColliderId,
    category: "collision" | "area",
  ): PhysicsChangeResult {
    const key = physics_id_key(collision);
    const body = this.#bodies.get(key);
    if (body === undefined) {
      return {
        type: "failed",
        reason: `2D collision ${key} is missing or stale`,
      };
    }
    const is_area = this.#areas.has(key);
    if ((category === "area") !== is_area) {
      return {
        type: "failed",
        reason: `2D collision ${key} is a${is_area ? "n area" : " solid"}`,
      };
    }
    const result = this.#world.destroy_body(body);
    if (result.type === "failed") return result;
    this.#bodies.delete(key);
    this.#areas.delete(key);
    return result;
  }

  raycast(
    origin: Vec2,
    direction: Vec2,
    maximum_distance: number,
    filter: CollisionQueryFilter2d = {},
  ): readonly CollisionHit2d[] {
    const hits = this.#world.raycast(
      ray(vec3(origin.x, origin.y, 0), vec3(direction.x, direction.y, 0)),
      maximum_distance,
      query_filter_3d(filter),
    );
    return Object.freeze(hits.map((hit) =>
      Object.freeze({
        collision: hit.collider,
        distance: hit.distance,
        point: vec2(hit.point.x, hit.point.y),
        normal: vec2(hit.normal.x, hit.normal.y),
      })
    ));
  }

  overlap_shape(
    shape: ShapeId,
    pose: CollisionPose2d,
    filter: CollisionQueryFilter2d = {},
  ): readonly ColliderId[] {
    return this.#world.overlap_shape(
      shape,
      pose_3d(pose),
      query_filter_3d(filter),
    );
  }

  shape_cast(
    shape: ShapeId,
    pose: CollisionPose2d,
    direction: Vec2,
    maximum_distance: number,
    filter: CollisionQueryFilter2d = {},
  ): readonly CollisionHit2d[] {
    const hits = this.#world.shape_cast(
      shape,
      pose_3d(pose),
      vec3(direction.x, direction.y, 0),
      maximum_distance,
      query_filter_3d(filter),
    );
    return Object.freeze(hits.map((hit) =>
      Object.freeze({
        collision: hit.collider,
        distance: hit.distance,
        point: vec2(hit.point.x, hit.point.y),
        normal: vec2(hit.normal.x, hit.normal.y),
      })
    ));
  }

  step(): CollisionStep2d {
    const step = this.#world.step();
    return Object.freeze({
      tick: step.tick,
      collisions: Object.freeze(step.contacts.map(contact_2d)),
      areas: Object.freeze(step.triggers.map((event) => {
        const first_is_area = this.#areas.has(physics_id_key(event.first));
        return Object.freeze({
          type: event.type,
          area: first_is_area ? event.first : event.second,
          other: first_is_area ? event.second : event.first,
        });
      })),
    });
  }

  snapshot(): ReturnType<PhysicsWorld["snapshot"]> {
    return this.#world.snapshot();
  }

  #create_object(
    options: CollisionObject2dOptions,
    category: "collision" | "area",
  ): PhysicsMutationResult<ColliderId> {
    const body = this.#world.create_body({
      motion: "kinematic",
      pose: pose_3d(options),
    });
    if (body.type === "failed") return body;
    const collision = category === "area"
      ? this.#world.create_area({
        body: body.id,
        shape: options.shape,
        filter: options.filter,
      })
      : this.#world.create_collider({
        body: body.id,
        shape: options.shape,
        filter: options.filter,
      });
    if (collision.type === "failed") {
      this.#world.destroy_body(body.id);
      return collision;
    }
    const key = physics_id_key(collision.id);
    this.#bodies.set(key, body.id);
    if (category === "area") this.#areas.add(key);
    return collision;
  }
}

function pose_3d(pose: CollisionPose2d) {
  const rotation = finite_number(
    pose.rotation_radians ?? 0,
    "2D collision rotation",
  );
  return rigid_pose(
    vec3(pose.position.x, pose.position.y, 0),
    quat_from_axis_angle(vec3(0, 0, 1), rotation),
  );
}

function query_filter_3d(filter: CollisionQueryFilter2d): PhysicsQueryFilter {
  return {
    mask: filter.mask,
    ignored_colliders: filter.ignored_collisions,
    include_sensors: filter.include_areas,
  };
}

function contact_2d(contact: ContactEvent): CollisionContact2d {
  return Object.freeze({
    first: contact.first,
    second: contact.second,
  });
}
