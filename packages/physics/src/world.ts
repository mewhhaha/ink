import {
  DynamicAabbTree,
  type DynamicTreeHandle,
} from "@ink/geometry/dynamic_tree.ts";
import type { Ray } from "@ink/geometry/shapes.ts";
import { aabb_expand } from "@ink/geometry/shapes.ts";
import type { Quat } from "@ink/math/quaternion.ts";
import { quat_from_axis_angle, quat_multiply } from "@ink/math/quaternion.ts";
import { finite_number } from "@ink/math/scalar.ts";
import type { Vec3 } from "@ink/math/vector.ts";
import {
  vec3,
  vec3_add,
  vec3_cross,
  vec3_dot,
  vec3_length,
  vec3_length_squared,
  vec3_normalize,
  vec3_scale,
  vec3_subtract,
} from "@ink/math/vector.ts";
import type { Observer } from "@ink/observability/observer.ts";
import {
  closest_point_on_shape_bounds,
  collide_shapes,
  compose_rigid_pose,
  type ContactGeometry,
  raycast_shape,
  rigid_pose,
  type RigidPose,
  shape_world_bounds,
  sweep_shape_bounds,
} from "./collision.ts";
import {
  body_id,
  type BodyId,
  collider_id,
  type ColliderId,
  joint_id,
  type JointId,
  physics_id_equal,
  physics_id_key,
  physics_world_id,
  type PhysicsAllocatorSnapshot,
  PhysicsIdAllocator,
  type PhysicsWorldId,
  shape_id,
  type ShapeId,
  validate_physics_allocator_snapshot,
} from "./identity.ts";
import { collision_shape, type CollisionShape } from "./shapes.ts";

export type MotionType = "static" | "kinematic" | "dynamic";
export type MaterialCombination =
  | "average"
  | "minimum"
  | "maximum"
  | "multiply";

export interface CollisionFilter {
  readonly membership: number;
  readonly collides_with: number;
  readonly group: number;
}

export interface PhysicsMaterial {
  readonly friction: number;
  readonly restitution: number;
  readonly combination: MaterialCombination;
}

export interface PhysicsWorldOptions {
  readonly id: PhysicsWorldId;
  readonly fixed_step_seconds: number;
  readonly gravity?: Vec3;
  readonly solver_iterations?: number;
  readonly position_iterations?: number;
  readonly sleep_speed?: number;
  readonly sleep_seconds?: number;
  readonly broadphase_margin?: number;
  readonly observer?: Observer;
}

export interface BodyOptions {
  readonly motion: MotionType;
  readonly pose?: RigidPose;
  readonly linear_velocity?: Vec3;
  readonly angular_velocity?: Vec3;
  readonly mass?: number;
  readonly inertia?: Vec3;
  readonly gravity_scale?: number;
  readonly linear_damping?: number;
  readonly angular_damping?: number;
  readonly continuous?: boolean;
  readonly sleep_allowed?: boolean;
}

export interface ColliderOptions {
  readonly body: BodyId;
  readonly shape: ShapeId;
  readonly local_pose?: RigidPose;
  readonly sensor?: boolean;
  readonly filter?: CollisionFilter;
  readonly material?: PhysicsMaterial;
}

export type JointDefinition =
  | { readonly type: "fixed"; readonly break_force?: number }
  | { readonly type: "ball"; readonly break_force?: number }
  | {
    readonly type: "distance";
    readonly minimum: number;
    readonly maximum: number;
    readonly break_force?: number;
  }
  | {
    readonly type: "spring";
    readonly rest_length: number;
    readonly stiffness: number;
    readonly damping: number;
    readonly break_force?: number;
  }
  | {
    readonly type: "hinge";
    readonly axis: Vec3;
    readonly minimum_angle?: number;
    readonly maximum_angle?: number;
    readonly motor?: JointMotor;
    readonly break_force?: number;
  }
  | {
    readonly type: "slider";
    readonly axis: Vec3;
    readonly minimum: number;
    readonly maximum: number;
    readonly motor?: JointMotor;
    readonly break_force?: number;
  };

export interface JointMotor {
  readonly target_velocity: number;
  readonly maximum_force: number;
}

export interface JointOptions {
  readonly first: BodyId;
  readonly second: BodyId;
  readonly first_anchor?: Vec3;
  readonly second_anchor?: Vec3;
  readonly definition: JointDefinition;
  readonly collide_connected?: boolean;
}

export type PhysicsMutationResult<Id> =
  | { readonly type: "created"; readonly id: Id }
  | { readonly type: "failed"; readonly reason: string };

export type PhysicsChangeResult =
  | { readonly type: "changed" }
  | { readonly type: "failed"; readonly reason: string };

export interface BodyState {
  readonly id: BodyId;
  readonly motion: MotionType;
  readonly pose: RigidPose;
  readonly linear_velocity: Vec3;
  readonly angular_velocity: Vec3;
  readonly sleeping: boolean;
}

export interface ContactEvent {
  readonly first: ColliderId;
  readonly second: ColliderId;
  readonly first_body: BodyId;
  readonly second_body: BodyId;
  readonly normal: Vec3;
  readonly point: Vec3;
  readonly penetration: number;
  readonly normal_impulse: number;
}

export interface TriggerEvent {
  readonly type: "entered" | "stayed" | "exited";
  readonly first: ColliderId;
  readonly second: ColliderId;
}

export interface SleepTransition {
  readonly body: BodyId;
  readonly type: "slept" | "woke";
}

export interface BrokenJoint {
  readonly joint: JointId;
  readonly force: number;
}

export interface PhysicsStep {
  readonly tick: number;
  readonly poses: readonly BodyState[];
  readonly contacts: readonly ContactEvent[];
  readonly triggers: readonly TriggerEvent[];
  readonly sleep_transitions: readonly SleepTransition[];
  readonly broken_joints: readonly BrokenJoint[];
  readonly diagnostics: {
    readonly broadphase_pairs: number;
    readonly islands: number;
    readonly sleeping_bodies: number;
    readonly ccd_casts: number;
    readonly solver_residual: number;
  };
}

export interface PhysicsQueryFilter {
  readonly mask?: number;
  readonly ignored_bodies?: readonly BodyId[];
  readonly ignored_colliders?: readonly ColliderId[];
  readonly include_sensors?: boolean;
}

export interface PhysicsQueryHit {
  readonly collider: ColliderId;
  readonly body: BodyId;
  readonly distance: number;
  readonly point: Vec3;
  readonly normal: Vec3;
}

export interface ClosestPointHit {
  readonly collider: ColliderId;
  readonly body: BodyId;
  readonly distance: number;
  readonly point: Vec3;
}

export interface CharacterMoveOptions {
  readonly shape: ShapeId;
  readonly pose: RigidPose;
  readonly displacement: Vec3;
  readonly step_height: number;
  readonly maximum_slope_radians: number;
  readonly skin: number;
  readonly filter?: PhysicsQueryFilter;
}

export interface CharacterMoveResult {
  readonly pose: RigidPose;
  readonly displacement: Vec3;
  readonly grounded: boolean;
  readonly contacts: readonly PhysicsQueryHit[];
}

interface ShapeRecord {
  readonly id: ShapeId;
  readonly shape: CollisionShape;
  references: number;
}

interface BodyRecord {
  readonly id: BodyId;
  motion: MotionType;
  pose: RigidPose;
  linear_velocity: Vec3;
  angular_velocity: Vec3;
  force: Vec3;
  torque: Vec3;
  inverse_mass: number;
  inverse_inertia: Vec3;
  gravity_scale: number;
  linear_damping: number;
  angular_damping: number;
  continuous: boolean;
  sleep_allowed: boolean;
  sleeping: boolean;
  still_seconds: number;
}

interface ColliderRecord {
  readonly id: ColliderId;
  readonly body: BodyId;
  readonly shape: ShapeId;
  readonly local_pose: RigidPose;
  readonly sensor: boolean;
  readonly filter: CollisionFilter;
  readonly material: PhysicsMaterial;
  tree_handle: DynamicTreeHandle;
}

interface JointRecord {
  readonly id: JointId;
  readonly first: BodyId;
  readonly second: BodyId;
  readonly first_anchor: Vec3;
  readonly second_anchor: Vec3;
  readonly definition: JointDefinition;
  readonly collide_connected: boolean;
  readonly initial_offset: Vec3;
}

interface ActiveContact extends ContactEvent {
  accumulated_impulse: number;
}

export interface PhysicsSnapshot {
  readonly format: "ink.physics";
  readonly version: 1;
  readonly world: PhysicsWorldId;
  readonly fixed_step_seconds: number;
  readonly tick: number;
  readonly allocators: {
    readonly shapes: PhysicsAllocatorSnapshot;
    readonly bodies: PhysicsAllocatorSnapshot;
    readonly colliders: PhysicsAllocatorSnapshot;
    readonly joints: PhysicsAllocatorSnapshot;
  };
  readonly shapes: readonly {
    readonly id: ShapeId;
    readonly shape: CollisionShape;
    readonly references: number;
  }[];
  readonly bodies: readonly BodySnapshot[];
  readonly colliders: readonly Omit<ColliderRecord, "tree_handle">[];
  readonly joints: readonly JointRecord[];
  readonly warm_starts: readonly {
    readonly pair: string;
    readonly impulse: number;
  }[];
  readonly triggers: readonly string[];
}

interface BodySnapshot extends Omit<BodyRecord, "id"> {
  readonly id: BodyId;
}

const zero = (): Vec3 => vec3(0, 0, 0);
const default_filter: CollisionFilter = Object.freeze({
  membership: 0xffff_ffff,
  collides_with: 0xffff_ffff,
  group: 0,
});
const default_material: PhysicsMaterial = Object.freeze({
  friction: 0.5,
  restitution: 0,
  combination: "average",
});

export class PhysicsWorld {
  readonly #id: PhysicsWorldId;
  readonly #fixed_step: number;
  readonly #gravity: Vec3;
  readonly #solver_iterations: number;
  readonly #position_iterations: number;
  readonly #sleep_speed: number;
  readonly #sleep_seconds: number;
  readonly #broadphase_margin: number;
  readonly #observer: Observer | undefined;
  readonly #shape_allocator = new PhysicsIdAllocator(shape_id);
  readonly #body_allocator = new PhysicsIdAllocator(body_id);
  readonly #collider_allocator = new PhysicsIdAllocator(collider_id);
  readonly #joint_allocator = new PhysicsIdAllocator(joint_id);
  readonly #shapes = new Map<number, ShapeRecord>();
  readonly #bodies = new Map<number, BodyRecord>();
  readonly #colliders = new Map<number, ColliderRecord>();
  readonly #joints = new Map<number, JointRecord>();
  #tree = new DynamicAabbTree<ColliderId>();
  #warm_starts = new Map<string, number>();
  #trigger_pairs = new Set<string>();
  #tick = 0;

  constructor(options: PhysicsWorldOptions) {
    if (physics_world_id(options.id) !== options.id) {
      throw new Error(
        `physics world id ${JSON.stringify(options.id)} is not canonical`,
      );
    }
    this.#id = options.id;
    this.#fixed_step = positive(
      options.fixed_step_seconds,
      "physics fixed step",
    );
    this.#gravity = options.gravity === undefined
      ? vec3(0, -9.81, 0)
      : vec3(options.gravity.x, options.gravity.y, options.gravity.z);
    this.#solver_iterations = positive_integer(
      options.solver_iterations ?? 8,
      "solver iterations",
    );
    this.#position_iterations = positive_integer(
      options.position_iterations ?? 3,
      "position iterations",
    );
    this.#sleep_speed = nonnegative(options.sleep_speed ?? 0.05, "sleep speed");
    this.#sleep_seconds = positive(
      options.sleep_seconds ?? 0.5,
      "sleep seconds",
    );
    this.#broadphase_margin = nonnegative(
      options.broadphase_margin ?? 0.05,
      "broadphase margin",
    );
    this.#observer = options.observer;
  }

  get tick(): number {
    return this.#tick;
  }

  create_shape(shape: CollisionShape): PhysicsMutationResult<ShapeId> {
    const parsed = collision_shape(shape);
    const id = this.#shape_allocator.allocate();
    this.#shapes.set(id.index, { id, shape: parsed, references: 0 });
    return { type: "created", id };
  }

  destroy_shape(id: ShapeId): PhysicsChangeResult {
    const found = this.#shape(id);
    if (found.type === "failed") return found;
    if (found.record.references > 0) {
      return {
        type: "failed",
        reason: `shape ${
          physics_id_key(id)
        } is referenced by ${found.record.references} colliders`,
      };
    }
    this.#shapes.delete(id.index);
    this.#shape_allocator.retire(id);
    return { type: "changed" };
  }

  create_body(options: BodyOptions): PhysicsMutationResult<BodyId> {
    if (
      options.motion !== "static" && options.motion !== "kinematic" &&
      options.motion !== "dynamic"
    ) {
      return {
        type: "failed",
        reason: `physics body motion ${
          JSON.stringify(options.motion)
        } is unsupported`,
      };
    }
    const mass = options.motion === "dynamic"
      ? positive(options.mass ?? 1, "dynamic body mass")
      : Infinity;
    const inertia = options.inertia ??
      (options.motion === "dynamic" ? vec3(mass, mass, mass) : zero());
    if (
      options.motion === "dynamic" &&
      (![inertia.x, inertia.y, inertia.z].every(Number.isFinite) ||
        inertia.x <= 0 || inertia.y <= 0 || inertia.z <= 0)
    ) {
      return {
        type: "failed",
        reason:
          `dynamic body inertia (${inertia.x}, ${inertia.y}, ${inertia.z}) must be positive`,
      };
    }
    if (
      (options.continuous !== undefined &&
        typeof options.continuous !== "boolean") ||
      (options.sleep_allowed !== undefined &&
        typeof options.sleep_allowed !== "boolean")
    ) {
      return {
        type: "failed",
        reason:
          "physics body continuous and sleep-allowed options must be boolean",
      };
    }
    const id = this.#body_allocator.allocate();
    this.#bodies.set(id.index, {
      id,
      motion: options.motion,
      pose: options.pose === undefined
        ? rigid_pose(zero())
        : rigid_pose(options.pose.position, options.pose.rotation),
      linear_velocity: options.linear_velocity === undefined
        ? zero()
        : snapshot_vector(options.linear_velocity),
      angular_velocity: options.angular_velocity === undefined
        ? zero()
        : snapshot_vector(options.angular_velocity),
      force: zero(),
      torque: zero(),
      inverse_mass: options.motion === "dynamic" ? 1 / mass : 0,
      inverse_inertia: options.motion === "dynamic"
        ? vec3(1 / inertia.x, 1 / inertia.y, 1 / inertia.z)
        : zero(),
      gravity_scale: finite(options.gravity_scale ?? 1, "gravity scale"),
      linear_damping: nonnegative(
        options.linear_damping ?? 0.01,
        "linear damping",
      ),
      angular_damping: nonnegative(
        options.angular_damping ?? 0.01,
        "angular damping",
      ),
      continuous: options.continuous ?? false,
      sleep_allowed: options.sleep_allowed ?? true,
      sleeping: false,
      still_seconds: 0,
    });
    return { type: "created", id };
  }

  destroy_body(id: BodyId): PhysicsChangeResult {
    const found = this.#body(id);
    if (found.type === "failed") return found;
    const colliders = this.#ordered_colliders().filter((collider) =>
      physics_id_equal(collider.body, id)
    );
    for (const collider of colliders) this.destroy_collider(collider.id);
    const joints = this.#ordered_joints().filter((joint) =>
      physics_id_equal(joint.first, id) || physics_id_equal(joint.second, id)
    );
    for (const joint of joints) this.destroy_joint(joint.id);
    this.#bodies.delete(id.index);
    this.#body_allocator.retire(id);
    return { type: "changed" };
  }

  create_collider(options: ColliderOptions): PhysicsMutationResult<ColliderId> {
    if (options.sensor !== undefined && typeof options.sensor !== "boolean") {
      return {
        type: "failed",
        reason: `physics collider sensor ${
          JSON.stringify(options.sensor)
        } must be boolean`,
      };
    }
    const body = this.#body(options.body);
    if (body.type === "failed") return body;
    const shape = this.#shape(options.shape);
    if (shape.type === "failed") return shape;
    if (
      body.record.motion !== "static" &&
      (shape.record.shape.type === "triangle_mesh" ||
        shape.record.shape.type === "heightfield")
    ) {
      return {
        type: "failed",
        reason: `body ${
          physics_id_key(options.body)
        } cannot attach concave shape ${
          physics_id_key(options.shape)
        } with motion ${body.record.motion}`,
      };
    }
    const filter = parse_filter(options.filter ?? default_filter);
    const material = parse_material(options.material ?? default_material);
    const id = this.#collider_allocator.allocate();
    const local_pose = options.local_pose === undefined
      ? rigid_pose(zero())
      : rigid_pose(options.local_pose.position, options.local_pose.rotation);
    const bounds = aabb_expand(
      shape_world_bounds(
        shape.record.shape,
        compose_rigid_pose(body.record.pose, local_pose),
      ),
      this.#broadphase_margin,
    );
    const tree_handle = this.#tree.insert(bounds, id);
    this.#colliders.set(id.index, {
      id,
      body: options.body,
      shape: options.shape,
      local_pose,
      sensor: options.sensor ?? false,
      filter,
      material,
      tree_handle,
    });
    shape.record.references += 1;
    return { type: "created", id };
  }

  create_area(
    options: Omit<ColliderOptions, "sensor">,
  ): PhysicsMutationResult<ColliderId> {
    return this.create_collider({ ...options, sensor: true });
  }

  destroy_collider(id: ColliderId): PhysicsChangeResult {
    const found = this.#collider(id);
    if (found.type === "failed") return found;
    this.#tree.remove(found.record.tree_handle);
    this.#colliders.delete(id.index);
    this.#collider_allocator.retire(id);
    const shape = this.#shape(found.record.shape);
    if (shape.type === "ready") shape.record.references -= 1;
    return { type: "changed" };
  }

  create_joint(options: JointOptions): PhysicsMutationResult<JointId> {
    if (
      options.collide_connected !== undefined &&
      typeof options.collide_connected !== "boolean"
    ) {
      return {
        type: "failed",
        reason: `physics joint collide-connected ${
          JSON.stringify(options.collide_connected)
        } must be boolean`,
      };
    }
    const first = this.#body(options.first);
    if (first.type === "failed") return first;
    const second = this.#body(options.second);
    if (second.type === "failed") return second;
    if (physics_id_equal(options.first, options.second)) {
      return {
        type: "failed",
        reason: `joint cannot connect body ${
          physics_id_key(options.first)
        } to itself`,
      };
    }
    const definition = parse_joint(options.definition);
    const id = this.#joint_allocator.allocate();
    this.#joints.set(id.index, {
      id,
      first: options.first,
      second: options.second,
      first_anchor: options.first_anchor === undefined
        ? zero()
        : snapshot_vector(options.first_anchor),
      second_anchor: options.second_anchor === undefined
        ? zero()
        : snapshot_vector(options.second_anchor),
      definition,
      collide_connected: options.collide_connected ?? false,
      initial_offset: vec3_subtract(
        second.record.pose.position,
        first.record.pose.position,
      ),
    });
    return { type: "created", id };
  }

  destroy_joint(id: JointId): PhysicsChangeResult {
    const found = this.#joint(id);
    if (found.type === "failed") return found;
    this.#joints.delete(id.index);
    this.#joint_allocator.retire(id);
    return { type: "changed" };
  }

  body_state(id: BodyId): BodyState | null {
    const found = this.#body(id);
    return found.type === "failed" ? null : freeze_body_state(found.record);
  }

  set_kinematic_pose(id: BodyId, pose: RigidPose): PhysicsChangeResult {
    const found = this.#body(id);
    if (found.type === "failed") return found;
    if (found.record.motion !== "kinematic") {
      return {
        type: "failed",
        reason: `body ${
          physics_id_key(id)
        } has motion ${found.record.motion}, expected kinematic`,
      };
    }
    found.record.linear_velocity = vec3_scale(
      vec3_subtract(pose.position, found.record.pose.position),
      1 / this.#fixed_step,
    );
    found.record.pose = rigid_pose(pose.position, pose.rotation);
    this.#wake(found.record);
    this.#update_body_colliders(id);
    return { type: "changed" };
  }

  apply_force(id: BodyId, force: Vec3, point?: Vec3): PhysicsChangeResult {
    const found = this.#dynamic_body(id);
    if (found.type === "failed") return found;
    found.record.force = vec3_add(found.record.force, force);
    if (point !== undefined) {
      found.record.torque = vec3_add(
        found.record.torque,
        vec3_cross(vec3_subtract(point, found.record.pose.position), force),
      );
    }
    this.#wake(found.record);
    return { type: "changed" };
  }

  apply_impulse(id: BodyId, impulse: Vec3, point?: Vec3): PhysicsChangeResult {
    const found = this.#dynamic_body(id);
    if (found.type === "failed") return found;
    found.record.linear_velocity = vec3_add(
      found.record.linear_velocity,
      vec3_scale(impulse, found.record.inverse_mass),
    );
    if (point !== undefined) {
      const angular_impulse = vec3_cross(
        vec3_subtract(point, found.record.pose.position),
        impulse,
      );
      found.record.angular_velocity = vec3_add(
        found.record.angular_velocity,
        multiply_components(angular_impulse, found.record.inverse_inertia),
      );
    }
    this.#wake(found.record);
    return { type: "changed" };
  }

  step(delta_seconds = this.#fixed_step): PhysicsStep {
    if (this.#tick === Number.MAX_SAFE_INTEGER) {
      throw new Error("physics tick cannot advance safely");
    }
    finite_number(delta_seconds, "physics step seconds");
    if (Math.abs(delta_seconds - this.#fixed_step) > 1e-12) {
      throw new Error(
        `physics world ${this.#id} requires fixed step ${this.#fixed_step}, received ${delta_seconds}`,
      );
    }
    const sleep_transitions: SleepTransition[] = [];
    let ccd_casts = 0;
    for (const body of this.#ordered_bodies()) {
      if (body.motion !== "dynamic" || body.sleeping) continue;
      body.linear_velocity = vec3_add(
        body.linear_velocity,
        vec3_scale(
          vec3_add(
            vec3_scale(this.#gravity, body.gravity_scale),
            vec3_scale(body.force, body.inverse_mass),
          ),
          this.#fixed_step,
        ),
      );
      body.angular_velocity = vec3_add(
        body.angular_velocity,
        vec3_scale(
          multiply_components(body.torque, body.inverse_inertia),
          this.#fixed_step,
        ),
      );
      body.linear_velocity = vec3_scale(
        body.linear_velocity,
        Math.max(0, 1 - body.linear_damping * this.#fixed_step),
      );
      body.angular_velocity = vec3_scale(
        body.angular_velocity,
        Math.max(0, 1 - body.angular_damping * this.#fixed_step),
      );
      let displacement = vec3_scale(body.linear_velocity, this.#fixed_step);
      if (body.continuous && vec3_length_squared(displacement) > 0) {
        const fraction = this.#continuous_fraction(body, displacement);
        displacement = vec3_scale(displacement, fraction);
        ccd_casts += 1;
      }
      body.pose = rigid_pose(
        vec3_add(body.pose.position, displacement),
        integrate_rotation(
          body.pose.rotation,
          body.angular_velocity,
          this.#fixed_step,
        ),
      );
      body.force = zero();
      body.torque = zero();
      this.#update_body_colliders(body.id);
    }
    const pairs = this.#broadphase_pairs();
    const active_contacts: ActiveContact[] = [];
    const current_triggers = new Set<string>();
    for (const [first, second] of pairs) {
      const geometry = this.#collision(first, second);
      if (geometry === null) continue;
      const pair = pair_key(first.id, second.id);
      if (first.sensor || second.sensor) {
        current_triggers.add(pair);
        continue;
      }
      active_contacts.push(this.#active_contact(first, second, geometry, pair));
    }
    let residual = 0;
    for (let iteration = 0; iteration < this.#solver_iterations; iteration++) {
      residual = 0;
      for (const contact of active_contacts) {
        residual = Math.max(residual, this.#solve_velocity(contact));
      }
      for (const joint of this.#ordered_joints()) {
        residual = Math.max(residual, this.#solve_joint_velocity(joint));
      }
    }
    const broken_joints: BrokenJoint[] = [];
    for (
      let iteration = 0;
      iteration < this.#position_iterations;
      iteration++
    ) {
      for (const contact of active_contacts) this.#solve_position(contact);
      for (const joint of this.#ordered_joints()) {
        const force = this.#solve_joint_position(joint);
        const threshold = joint.definition.break_force;
        if (
          threshold !== undefined && force > threshold &&
          !broken_joints.some(({ joint: id }) => physics_id_equal(id, joint.id))
        ) {
          broken_joints.push(Object.freeze({ joint: joint.id, force }));
        }
      }
    }
    for (const broken of broken_joints) this.destroy_joint(broken.joint);
    for (const body of this.#ordered_bodies()) {
      if (body.motion !== "dynamic" || !body.sleep_allowed) continue;
      const speed = Math.max(
        vec3_length(body.linear_velocity),
        vec3_length(body.angular_velocity),
      );
      if (speed <= this.#sleep_speed) body.still_seconds += this.#fixed_step;
      else body.still_seconds = 0;
      if (!body.sleeping && body.still_seconds >= this.#sleep_seconds) {
        body.sleeping = true;
        body.linear_velocity = zero();
        body.angular_velocity = zero();
        sleep_transitions.push(Object.freeze({ body: body.id, type: "slept" }));
      }
    }
    const triggers = trigger_events(
      this.#trigger_pairs,
      current_triggers,
      this.#colliders,
    );
    this.#trigger_pairs = current_triggers;
    this.#warm_starts = new Map(
      active_contacts.map((
        contact,
      ) => [
        pair_key(contact.first, contact.second),
        contact.accumulated_impulse,
      ]),
    );
    this.#tick += 1;
    const sleeping_bodies =
      this.#ordered_bodies().filter((body) => body.sleeping).length;
    const islands = count_islands(
      this.#ordered_bodies(),
      active_contacts,
      this.#ordered_joints(),
    );
    this.#observer?.event("physics.step", {
      tick: this.#tick,
      broadphase_pairs: pairs.length,
      contacts: active_contacts.length,
      islands,
      sleeping_bodies,
      ccd_casts,
      solver_residual: residual,
    });
    return Object.freeze({
      tick: this.#tick,
      poses: Object.freeze(this.#ordered_bodies().map(freeze_body_state)),
      contacts: Object.freeze(active_contacts.map(freeze_contact)),
      triggers: Object.freeze(triggers),
      sleep_transitions: Object.freeze(sleep_transitions),
      broken_joints: Object.freeze(broken_joints),
      diagnostics: Object.freeze({
        broadphase_pairs: pairs.length,
        islands,
        sleeping_bodies,
        ccd_casts,
        solver_residual: residual,
      }),
    });
  }

  raycast(
    cast: Ray,
    maximum_distance: number,
    filter: PhysicsQueryFilter = {},
  ): readonly PhysicsQueryHit[] {
    nonnegative(maximum_distance, "raycast maximum distance");
    const hits: PhysicsQueryHit[] = [];
    for (const collider of this.#query_colliders(filter)) {
      const shape = this.#shapes.get(collider.shape.index)!;
      const body = this.#bodies.get(collider.body.index)!;
      const hit = raycast_shape(
        cast,
        maximum_distance,
        shape.shape,
        compose_rigid_pose(body.pose, collider.local_pose),
      );
      if (hit !== null) {
        hits.push(
          Object.freeze({ collider: collider.id, body: collider.body, ...hit }),
        );
      }
    }
    return Object.freeze(hits.sort(compare_query_hits));
  }

  overlap_shape(
    shape_id_value: ShapeId,
    pose: RigidPose,
    filter: PhysicsQueryFilter = {},
  ): readonly ColliderId[] {
    const shape = this.#shape(shape_id_value);
    if (shape.type === "failed") return Object.freeze([]);
    const matches: ColliderId[] = [];
    for (const collider of this.#query_colliders(filter)) {
      const target_shape = this.#shapes.get(collider.shape.index)!;
      const body = this.#bodies.get(collider.body.index)!;
      if (
        collide_shapes(
          shape.record.shape,
          pose,
          target_shape.shape,
          compose_rigid_pose(body.pose, collider.local_pose),
        ) !== null
      ) {
        matches.push(collider.id);
      }
    }
    return Object.freeze(matches.sort(compare_ids));
  }

  shape_cast(
    shape_id_value: ShapeId,
    pose: RigidPose,
    direction: Vec3,
    maximum_distance: number,
    filter: PhysicsQueryFilter = {},
  ): readonly PhysicsQueryHit[] {
    const shape = this.#shape(shape_id_value);
    if (shape.type === "failed") return Object.freeze([]);
    nonnegative(maximum_distance, "shape cast maximum distance");
    if (vec3_length_squared(direction) === 0 && maximum_distance > 0) {
      throw new Error(
        "shape cast direction cannot be zero for positive distance",
      );
    }
    const cast_direction = maximum_distance === 0
      ? direction
      : vec3_normalize(direction);
    const hits: PhysicsQueryHit[] = [];
    for (const collider of this.#query_colliders(filter)) {
      const target_shape = this.#shapes.get(collider.shape.index)!;
      const body = this.#bodies.get(collider.body.index)!;
      const hit = sweep_shape_bounds(
        shape.record.shape,
        pose,
        cast_direction,
        maximum_distance,
        target_shape.shape,
        compose_rigid_pose(body.pose, collider.local_pose),
      );
      if (hit !== null) {
        hits.push(
          Object.freeze({ collider: collider.id, body: collider.body, ...hit }),
        );
      }
    }
    return Object.freeze(hits.sort(compare_query_hits));
  }

  closest_points(
    point: Vec3,
    maximum_distance: number,
    filter: PhysicsQueryFilter = {},
  ): readonly ClosestPointHit[] {
    nonnegative(maximum_distance, "closest point maximum distance");
    const hits: ClosestPointHit[] = [];
    for (const collider of this.#query_colliders(filter)) {
      const shape = this.#shapes.get(collider.shape.index)!;
      const body = this.#bodies.get(collider.body.index)!;
      const closest = closest_point_on_shape_bounds(
        point,
        shape.shape,
        compose_rigid_pose(body.pose, collider.local_pose),
      );
      const distance = vec3_length(vec3_subtract(closest, point));
      if (distance <= maximum_distance) {
        hits.push(
          Object.freeze({
            collider: collider.id,
            body: collider.body,
            distance,
            point: closest,
          }),
        );
      }
    }
    return Object.freeze(
      hits.sort((left, right) =>
        left.distance - right.distance ||
        compare_ids(left.collider, right.collider)
      ),
    );
  }

  move_character(options: CharacterMoveOptions): CharacterMoveResult {
    nonnegative(options.step_height, "character step height");
    nonnegative(options.skin, "character skin");
    if (
      !Number.isFinite(options.maximum_slope_radians) ||
      options.maximum_slope_radians < 0 ||
      options.maximum_slope_radians >= Math.PI / 2
    ) {
      throw new Error(
        `character maximum slope ${
          JSON.stringify(options.maximum_slope_radians)
        } must be within [0, pi/2)`,
      );
    }
    const distance = vec3_length(options.displacement);
    if (distance === 0) {
      return Object.freeze({
        pose: options.pose,
        displacement: zero(),
        grounded: false,
        contacts: Object.freeze([]),
      });
    }
    const direction = vec3_scale(options.displacement, 1 / distance);
    const first = this.shape_cast(
      options.shape,
      options.pose,
      direction,
      distance + options.skin,
      options.filter,
    )[0];
    if (first === undefined) {
      return Object.freeze({
        pose: rigid_pose(
          vec3_add(options.pose.position, options.displacement),
          options.pose.rotation,
        ),
        displacement: options.displacement,
        grounded: false,
        contacts: Object.freeze([]),
      });
    }
    const travelled = Math.max(0, first.distance - options.skin);
    let movement = vec3_scale(direction, travelled);
    const remainder = vec3_subtract(options.displacement, movement);
    const slide = vec3_subtract(
      remainder,
      vec3_scale(first.normal, vec3_dot(remainder, first.normal)),
    );
    movement = vec3_add(movement, slide);
    let pose = rigid_pose(
      vec3_add(options.pose.position, movement),
      options.pose.rotation,
    );
    const contacts = [first];
    if (options.step_height > 0 && Math.abs(first.normal.y) < 0.5) {
      const lifted = rigid_pose(
        vec3_add(options.pose.position, vec3(0, options.step_height, 0)),
        options.pose.rotation,
      );
      const stepped = this.shape_cast(
        options.shape,
        lifted,
        direction,
        distance,
        options.filter,
      )[0];
      if (stepped === undefined) {
        movement = vec3_add(
          options.displacement,
          vec3(0, options.step_height, 0),
        );
        pose = rigid_pose(
          vec3_add(options.pose.position, movement),
          options.pose.rotation,
        );
      }
    }
    const slope_cosine = Math.cos(options.maximum_slope_radians);
    return Object.freeze({
      pose,
      displacement: movement,
      grounded: first.normal.y >= slope_cosine,
      contacts: Object.freeze(contacts),
    });
  }

  rebase(offset: Vec3): void {
    for (const body of this.#ordered_bodies()) {
      body.pose = rigid_pose(
        vec3_subtract(body.pose.position, offset),
        body.pose.rotation,
      );
    }
    for (const body of this.#ordered_bodies()) {
      this.#update_body_colliders(body.id);
    }
    this.#observer?.event("physics.origin.rebased", {
      x: offset.x,
      y: offset.y,
      z: offset.z,
    });
  }

  snapshot(): PhysicsSnapshot {
    return Object.freeze({
      format: "ink.physics",
      version: 1,
      world: this.#id,
      fixed_step_seconds: this.#fixed_step,
      tick: this.#tick,
      allocators: Object.freeze({
        shapes: this.#shape_allocator.snapshot(),
        bodies: this.#body_allocator.snapshot(),
        colliders: this.#collider_allocator.snapshot(),
        joints: this.#joint_allocator.snapshot(),
      }),
      shapes: Object.freeze(
        this.#ordered_shapes().map((record) =>
          Object.freeze({
            ...record,
            shape: collision_shape(record.shape),
          })
        ),
      ),
      bodies: Object.freeze(
        this.#ordered_bodies().map((record) => Object.freeze({ ...record })),
      ),
      colliders: Object.freeze(
        this.#ordered_colliders().map((
          { tree_handle: _tree_handle, ...record },
        ) => Object.freeze(record)),
      ),
      joints: Object.freeze(
        this.#ordered_joints().map((record) => Object.freeze({ ...record })),
      ),
      warm_starts: Object.freeze(
        [...this.#warm_starts].sort(([left], [right]) =>
          left.localeCompare(right)
        ).map(([pair, impulse]) => Object.freeze({ pair, impulse })),
      ),
      triggers: Object.freeze([...this.#trigger_pairs].sort()),
    });
  }

  restore(snapshot: PhysicsSnapshot): PhysicsChangeResult {
    if (snapshot.format !== "ink.physics" || snapshot.version !== 1) {
      return {
        type: "failed",
        reason: `physics snapshot format ${String(snapshot.format)} version ${
          String(snapshot.version)
        } is unsupported`,
      };
    }
    if (
      snapshot.world !== this.#id ||
      snapshot.fixed_step_seconds !== this.#fixed_step
    ) {
      return {
        type: "failed",
        reason:
          `physics snapshot world ${snapshot.world} step ${snapshot.fixed_step_seconds} does not match ${this.#id} step ${this.#fixed_step}`,
      };
    }
    let next_shapes: Map<number, ShapeRecord>;
    let next_bodies: Map<number, BodyRecord>;
    let next_colliders: Map<number, ColliderRecord>;
    let next_joints: Map<number, JointRecord>;
    let next_tree: DynamicAabbTree<ColliderId>;
    let next_warm_starts: Map<string, number>;
    let next_triggers: Set<string>;
    try {
      if (!Number.isSafeInteger(snapshot.tick) || snapshot.tick < 0) {
        throw new Error(
          `physics snapshot tick ${
            JSON.stringify(snapshot.tick)
          } must be a nonnegative safe integer`,
        );
      }
      validate_allocator_records(
        snapshot.allocators.shapes,
        snapshot.shapes,
        "shape",
      );
      validate_allocator_records(
        snapshot.allocators.bodies,
        snapshot.bodies,
        "body",
      );
      validate_allocator_records(
        snapshot.allocators.colliders,
        snapshot.colliders,
        "collider",
      );
      validate_allocator_records(
        snapshot.allocators.joints,
        snapshot.joints,
        "joint",
      );

      next_shapes = new Map(snapshot.shapes.map((record) => [
        record.id.index,
        {
          id: shape_id(record.id.index, record.id.generation),
          shape: collision_shape(record.shape),
          references: 0,
        },
      ]));
      next_bodies = new Map(snapshot.bodies.map((record) => {
        if (
          !(["static", "kinematic", "dynamic"] as const).includes(record.motion)
        ) {
          throw new Error(
            `physics snapshot body ${physics_id_key(record.id)} motion ${
              JSON.stringify(record.motion)
            } is unsupported`,
          );
        }
        if (
          typeof record.continuous !== "boolean" ||
          typeof record.sleep_allowed !== "boolean" ||
          typeof record.sleeping !== "boolean"
        ) {
          throw new Error(
            `physics snapshot body ${
              physics_id_key(record.id)
            } boolean state is malformed`,
          );
        }
        const id = body_id(record.id.index, record.id.generation);
        const restored: BodyRecord = {
          ...record,
          id,
          pose: rigid_pose(record.pose.position, record.pose.rotation),
          linear_velocity: snapshot_vector(record.linear_velocity),
          angular_velocity: snapshot_vector(record.angular_velocity),
          force: snapshot_vector(record.force),
          torque: snapshot_vector(record.torque),
          inverse_mass: nonnegative(
            record.inverse_mass,
            "snapshot inverse mass",
          ),
          inverse_inertia: nonnegative_vector(
            record.inverse_inertia,
            "snapshot inverse inertia",
          ),
          gravity_scale: finite(record.gravity_scale, "snapshot gravity scale"),
          linear_damping: nonnegative(
            record.linear_damping,
            "snapshot linear damping",
          ),
          angular_damping: nonnegative(
            record.angular_damping,
            "snapshot angular damping",
          ),
          still_seconds: nonnegative(
            record.still_seconds,
            "snapshot still seconds",
          ),
        };
        return [id.index, restored];
      }));

      next_tree = new DynamicAabbTree<ColliderId>();
      next_colliders = new Map();
      for (const record of snapshot.colliders) {
        const shape = next_shapes.get(record.shape.index);
        const body = next_bodies.get(record.body.index);
        if (
          shape === undefined || body === undefined ||
          !physics_id_equal(shape.id, record.shape) ||
          !physics_id_equal(body.id, record.body)
        ) {
          throw new Error(
            `physics snapshot collider ${
              physics_id_key(record.id)
            } references missing body ${physics_id_key(record.body)} or shape ${
              physics_id_key(record.shape)
            }`,
          );
        }
        if (typeof record.sensor !== "boolean") {
          throw new Error(
            `physics snapshot collider ${physics_id_key(record.id)} sensor ${
              JSON.stringify(record.sensor)
            } must be boolean`,
          );
        }
        const id = collider_id(record.id.index, record.id.generation);
        const local_pose = rigid_pose(
          record.local_pose.position,
          record.local_pose.rotation,
        );
        const bounds = aabb_expand(
          shape_world_bounds(
            shape.shape,
            compose_rigid_pose(body.pose, local_pose),
          ),
          this.#broadphase_margin,
        );
        next_colliders.set(id.index, {
          ...record,
          id,
          body: body.id,
          shape: shape.id,
          local_pose,
          filter: parse_filter(record.filter),
          material: parse_material(record.material),
          tree_handle: next_tree.insert(bounds, id),
        });
        shape.references += 1;
      }

      next_joints = new Map();
      for (const record of snapshot.joints) {
        const first = next_bodies.get(record.first.index);
        const second = next_bodies.get(record.second.index);
        if (
          first === undefined || second === undefined ||
          !physics_id_equal(first.id, record.first) ||
          !physics_id_equal(second.id, record.second)
        ) {
          throw new Error(
            `physics snapshot joint ${
              physics_id_key(record.id)
            } references missing body`,
          );
        }
        if (typeof record.collide_connected !== "boolean") {
          throw new Error(
            `physics snapshot joint ${
              physics_id_key(record.id)
            } collide-connected state must be boolean`,
          );
        }
        const id = joint_id(record.id.index, record.id.generation);
        next_joints.set(id.index, {
          ...record,
          id,
          first: first.id,
          second: second.id,
          first_anchor: snapshot_vector(record.first_anchor),
          second_anchor: snapshot_vector(record.second_anchor),
          definition: parse_joint(record.definition),
          initial_offset: snapshot_vector(record.initial_offset),
        });
      }

      next_warm_starts = new Map();
      for (const entry of snapshot.warm_starts) {
        if (typeof entry.pair !== "string" || entry.pair.length === 0) {
          throw new Error(
            `physics snapshot warm-start pair ${
              JSON.stringify(entry.pair)
            } must be nonempty`,
          );
        }
        if (next_warm_starts.has(entry.pair)) {
          throw new Error(
            `physics snapshot repeats warm-start pair ${entry.pair}`,
          );
        }
        next_warm_starts.set(
          entry.pair,
          nonnegative(entry.impulse, `snapshot warm-start ${entry.pair}`),
        );
      }
      next_triggers = new Set();
      for (const pair of snapshot.triggers) {
        if (
          typeof pair !== "string" || pair.length === 0 ||
          next_triggers.has(pair)
        ) {
          throw new Error(
            `physics snapshot trigger pair ${
              JSON.stringify(pair)
            } is empty or repeated`,
          );
        }
        next_triggers.add(pair);
      }
    } catch (error) {
      return {
        type: "failed",
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    this.#shape_allocator.restore(snapshot.allocators.shapes);
    this.#body_allocator.restore(snapshot.allocators.bodies);
    this.#collider_allocator.restore(snapshot.allocators.colliders);
    this.#joint_allocator.restore(snapshot.allocators.joints);
    this.#shapes.clear();
    this.#bodies.clear();
    this.#colliders.clear();
    this.#joints.clear();
    for (const [index, record] of next_shapes) this.#shapes.set(index, record);
    for (const [index, record] of next_bodies) this.#bodies.set(index, record);
    for (const [index, record] of next_colliders) {
      this.#colliders.set(index, record);
    }
    for (const [index, record] of next_joints) this.#joints.set(index, record);
    this.#tree = next_tree;
    this.#warm_starts = next_warm_starts;
    this.#trigger_pairs = next_triggers;
    this.#tick = snapshot.tick;
    return { type: "changed" };
  }

  #shape(
    id: ShapeId,
  ): { type: "ready"; record: ShapeRecord } | {
    type: "failed";
    reason: string;
  } {
    const record = this.#shapes.get(id.index);
    if (record !== undefined && this.#shape_allocator.contains(id)) {
      return { type: "ready", record };
    }
    return {
      type: "failed",
      reason: `shape ${physics_id_key(id)} is missing or stale`,
    };
  }

  #body(
    id: BodyId,
  ): { type: "ready"; record: BodyRecord } | {
    type: "failed";
    reason: string;
  } {
    const record = this.#bodies.get(id.index);
    if (record !== undefined && this.#body_allocator.contains(id)) {
      return { type: "ready", record };
    }
    return {
      type: "failed",
      reason: `body ${physics_id_key(id)} is missing or stale`,
    };
  }

  #dynamic_body(
    id: BodyId,
  ): { type: "ready"; record: BodyRecord } | {
    type: "failed";
    reason: string;
  } {
    const found = this.#body(id);
    if (found.type === "failed") return found;
    if (found.record.motion !== "dynamic") {
      return {
        type: "failed",
        reason: `body ${
          physics_id_key(id)
        } has motion ${found.record.motion}, expected dynamic`,
      };
    }
    return found;
  }

  #collider(
    id: ColliderId,
  ): { type: "ready"; record: ColliderRecord } | {
    type: "failed";
    reason: string;
  } {
    const record = this.#colliders.get(id.index);
    if (record !== undefined && this.#collider_allocator.contains(id)) {
      return { type: "ready", record };
    }
    return {
      type: "failed",
      reason: `collider ${physics_id_key(id)} is missing or stale`,
    };
  }

  #joint(
    id: JointId,
  ): { type: "ready"; record: JointRecord } | {
    type: "failed";
    reason: string;
  } {
    const record = this.#joints.get(id.index);
    if (record !== undefined && this.#joint_allocator.contains(id)) {
      return { type: "ready", record };
    }
    return {
      type: "failed",
      reason: `joint ${physics_id_key(id)} is missing or stale`,
    };
  }

  #ordered_shapes(): ShapeRecord[] {
    return [...this.#shapes.values()].sort((left, right) =>
      compare_ids(left.id, right.id)
    );
  }

  #ordered_bodies(): BodyRecord[] {
    return [...this.#bodies.values()].sort((left, right) =>
      compare_ids(left.id, right.id)
    );
  }

  #ordered_colliders(): ColliderRecord[] {
    return [...this.#colliders.values()].sort((left, right) =>
      compare_ids(left.id, right.id)
    );
  }

  #ordered_joints(): JointRecord[] {
    return [...this.#joints.values()].sort((left, right) =>
      compare_ids(left.id, right.id)
    );
  }

  #update_body_colliders(id: BodyId): void {
    const body = this.#bodies.get(id.index)!;
    for (const collider of this.#ordered_colliders()) {
      if (!physics_id_equal(collider.body, id)) continue;
      const shape = this.#shapes.get(collider.shape.index)!;
      const bounds = aabb_expand(
        shape_world_bounds(
          shape.shape,
          compose_rigid_pose(body.pose, collider.local_pose),
        ),
        this.#broadphase_margin,
      );
      this.#tree.update(collider.tree_handle, bounds);
    }
  }

  #broadphase_pairs(): readonly [ColliderRecord, ColliderRecord][] {
    const pairs: [ColliderRecord, ColliderRecord][] = [];
    const blocked_joints = new Set(
      this.#ordered_joints().filter((joint) => !joint.collide_connected).map((
        joint,
      ) => body_pair_key(joint.first, joint.second)),
    );
    for (const first of this.#ordered_colliders()) {
      const first_shape = this.#shapes.get(first.shape.index)!;
      const first_body = this.#bodies.get(first.body.index)!;
      const bounds = shape_world_bounds(
        first_shape.shape,
        compose_rigid_pose(first_body.pose, first.local_pose),
      );
      for (const match of this.#tree.query(bounds)) {
        if (compare_ids(first.id, match.payload) >= 0) continue;
        const second = this.#colliders.get(match.payload.index);
        if (second === undefined || physics_id_equal(first.body, second.body)) {
          continue;
        }
        if (!filters_collide(first.filter, second.filter)) continue;
        if (blocked_joints.has(body_pair_key(first.body, second.body))) {
          continue;
        }
        pairs.push([first, second]);
      }
    }
    return Object.freeze(
      pairs.sort(([left_a, left_b], [right_a, right_b]) =>
        compare_ids(left_a.id, right_a.id) || compare_ids(left_b.id, right_b.id)
      ),
    );
  }

  #collision(
    first: ColliderRecord,
    second: ColliderRecord,
  ): ContactGeometry | null {
    const first_shape = this.#shapes.get(first.shape.index)!;
    const second_shape = this.#shapes.get(second.shape.index)!;
    const first_body = this.#bodies.get(first.body.index)!;
    const second_body = this.#bodies.get(second.body.index)!;
    return collide_shapes(
      first_shape.shape,
      compose_rigid_pose(first_body.pose, first.local_pose),
      second_shape.shape,
      compose_rigid_pose(second_body.pose, second.local_pose),
    );
  }

  #active_contact(
    first: ColliderRecord,
    second: ColliderRecord,
    geometry: ContactGeometry,
    pair: string,
  ): ActiveContact {
    return {
      first: first.id,
      second: second.id,
      first_body: first.body,
      second_body: second.body,
      ...geometry,
      normal_impulse: this.#warm_starts.get(pair) ?? 0,
      accumulated_impulse: this.#warm_starts.get(pair) ?? 0,
    };
  }

  #solve_velocity(contact: ActiveContact): number {
    const first = this.#bodies.get(contact.first_body.index)!;
    const second = this.#bodies.get(contact.second_body.index)!;
    const inverse_mass = first.inverse_mass + second.inverse_mass;
    if (inverse_mass === 0) return 0;
    const relative = vec3_subtract(
      second.linear_velocity,
      first.linear_velocity,
    );
    const normal_speed = vec3_dot(relative, contact.normal);
    const first_material = this.#colliders.get(contact.first.index)!.material;
    const second_material = this.#colliders.get(contact.second.index)!.material;
    const restitution = combine_coefficient(
      first_material.restitution,
      second_material.restitution,
      first_material.combination,
    );
    if (normal_speed >= 0) return 0;
    if (first.sleeping && -normal_speed > this.#sleep_speed) this.#wake(first);
    if (second.sleeping && -normal_speed > this.#sleep_speed) {
      this.#wake(second);
    }
    const bounce = contact.accumulated_impulse === 0 ? restitution : 0;
    const candidate = contact.accumulated_impulse -
      (1 + bounce) * normal_speed / inverse_mass;
    const impulse_delta = candidate - contact.accumulated_impulse;
    contact.accumulated_impulse = candidate;
    const impulse = vec3_scale(contact.normal, impulse_delta);
    this.#apply_contact_impulse(first, vec3_scale(impulse, -1), contact.point);
    this.#apply_contact_impulse(second, impulse, contact.point);
    const tangent_velocity = vec3_subtract(
      relative,
      vec3_scale(contact.normal, normal_speed),
    );
    const tangent_speed = vec3_length(tangent_velocity);
    if (tangent_speed > 1e-9) {
      const friction = combine_coefficient(
        first_material.friction,
        second_material.friction,
        first_material.combination,
      );
      const tangent = vec3_scale(tangent_velocity, 1 / tangent_speed);
      const friction_magnitude = Math.min(
        tangent_speed / inverse_mass,
        candidate * friction,
      );
      const friction_impulse = vec3_scale(tangent, -friction_magnitude);
      this.#apply_contact_impulse(
        first,
        vec3_scale(friction_impulse, -1),
        contact.point,
      );
      this.#apply_contact_impulse(second, friction_impulse, contact.point);
    }
    return Math.max(0, -normal_speed);
  }

  #solve_position(contact: ActiveContact): void {
    const first = this.#bodies.get(contact.first_body.index)!;
    const second = this.#bodies.get(contact.second_body.index)!;
    const inverse_mass = first.inverse_mass + second.inverse_mass;
    if (inverse_mass === 0) return;
    const correction = Math.max(0, contact.penetration - 0.001) * 0.25 /
      inverse_mass;
    if (first.motion === "dynamic") {
      first.pose = rigid_pose(
        vec3_subtract(
          first.pose.position,
          vec3_scale(contact.normal, correction * first.inverse_mass),
        ),
        first.pose.rotation,
      );
    }
    if (second.motion === "dynamic") {
      second.pose = rigid_pose(
        vec3_add(
          second.pose.position,
          vec3_scale(contact.normal, correction * second.inverse_mass),
        ),
        second.pose.rotation,
      );
    }
  }

  #solve_joint_velocity(joint: JointRecord): number {
    const first = this.#bodies.get(joint.first.index)!;
    const second = this.#bodies.get(joint.second.index)!;
    const relative = vec3_subtract(
      second.linear_velocity,
      first.linear_velocity,
    );
    const inverse_mass = first.inverse_mass + second.inverse_mass;
    if (inverse_mass === 0) return 0;
    if (joint.definition.type === "fixed" || joint.definition.type === "ball") {
      const impulse = vec3_scale(relative, -1 / inverse_mass);
      this.#apply_solver_impulse(first, vec3_scale(impulse, -1));
      this.#apply_solver_impulse(second, impulse);
      return vec3_length(relative);
    }
    if (
      joint.definition.type === "distance" || joint.definition.type === "spring"
    ) {
      const offset = vec3_subtract(second.pose.position, first.pose.position);
      if (vec3_length_squared(offset) === 0) return 0;
      const axis = vec3_normalize(offset);
      const speed = vec3_dot(relative, axis);
      const damping = joint.definition.type === "spring"
        ? joint.definition.damping
        : 1;
      const magnitude = -speed * Math.min(1, damping * this.#fixed_step) /
        inverse_mass;
      const impulse = vec3_scale(axis, magnitude);
      this.#apply_solver_impulse(first, vec3_scale(impulse, -1));
      this.#apply_solver_impulse(second, impulse);
      return Math.abs(speed);
    }
    const motor = joint.definition.motor;
    const axis = joint.definition.axis;
    if (joint.definition.type === "hinge") {
      const linear_impulse = vec3_scale(relative, -1 / inverse_mass);
      this.#apply_solver_impulse(first, vec3_scale(linear_impulse, -1));
      this.#apply_solver_impulse(second, linear_impulse);
      if (motor === undefined) return vec3_length(relative);
      const angular_error = motor.target_velocity -
        vec3_dot(
          vec3_subtract(second.angular_velocity, first.angular_velocity),
          axis,
        );
      const angular_impulse = Math.max(
        -motor.maximum_force * this.#fixed_step,
        Math.min(motor.maximum_force * this.#fixed_step, angular_error),
      );
      if (first.motion === "dynamic") {
        first.angular_velocity = vec3_subtract(
          first.angular_velocity,
          vec3_scale(axis, angular_impulse),
        );
      }
      if (second.motion === "dynamic") {
        second.angular_velocity = vec3_add(
          second.angular_velocity,
          vec3_scale(axis, angular_impulse),
        );
      }
      return Math.max(vec3_length(relative), Math.abs(angular_error));
    }
    const along = vec3_scale(axis, vec3_dot(relative, axis));
    const perpendicular = vec3_subtract(relative, along);
    const perpendicular_impulse = vec3_scale(perpendicular, -1 / inverse_mass);
    this.#apply_solver_impulse(first, vec3_scale(perpendicular_impulse, -1));
    this.#apply_solver_impulse(second, perpendicular_impulse);
    if (motor === undefined) return vec3_length(perpendicular);
    const error = motor.target_velocity - vec3_dot(relative, axis);
    const magnitude = Math.max(
      -motor.maximum_force * this.#fixed_step,
      Math.min(motor.maximum_force * this.#fixed_step, error / inverse_mass),
    );
    this.#apply_solver_impulse(first, vec3_scale(axis, -magnitude));
    this.#apply_solver_impulse(second, vec3_scale(axis, magnitude));
    return Math.max(vec3_length(perpendicular), Math.abs(error));
  }

  #solve_joint_position(joint: JointRecord): number {
    const first = this.#bodies.get(joint.first.index)!;
    const second = this.#bodies.get(joint.second.index)!;
    const first_anchor = vec3_add(first.pose.position, joint.first_anchor);
    const second_anchor = vec3_add(second.pose.position, joint.second_anchor);
    const offset = vec3_subtract(second_anchor, first_anchor);
    const distance = vec3_length(offset);
    const normal = distance === 0
      ? vec3(1, 0, 0)
      : vec3_scale(offset, 1 / distance);
    let error = 0;
    switch (joint.definition.type) {
      case "fixed":
        error = vec3_length(vec3_subtract(offset, joint.initial_offset));
        break;
      case "ball":
      case "hinge":
        error = distance;
        break;
      case "distance":
        error = distance < joint.definition.minimum
          ? distance - joint.definition.minimum
          : distance > joint.definition.maximum
          ? distance - joint.definition.maximum
          : 0;
        break;
      case "spring":
        error = (distance - joint.definition.rest_length) *
          Math.min(1, joint.definition.stiffness * this.#fixed_step ** 2);
        break;
      case "slider": {
        const along = vec3_dot(offset, joint.definition.axis);
        const perpendicular = vec3_subtract(
          offset,
          vec3_scale(joint.definition.axis, along),
        );
        const limit_error = along < joint.definition.minimum
          ? along - joint.definition.minimum
          : along > joint.definition.maximum
          ? along - joint.definition.maximum
          : 0;
        error = Math.sign(limit_error || 1) *
          (Math.abs(limit_error) + vec3_length(perpendicular));
        break;
      }
    }
    const inverse_mass = first.inverse_mass + second.inverse_mass;
    if (inverse_mass === 0 || error === 0) return 0;
    const correction = error * 0.3 / inverse_mass;
    if (first.motion === "dynamic") {
      first.pose = rigid_pose(
        vec3_add(
          first.pose.position,
          vec3_scale(normal, correction * first.inverse_mass),
        ),
        first.pose.rotation,
      );
    }
    if (second.motion === "dynamic") {
      second.pose = rigid_pose(
        vec3_subtract(
          second.pose.position,
          vec3_scale(normal, correction * second.inverse_mass),
        ),
        second.pose.rotation,
      );
    }
    return Math.abs(correction) / (this.#fixed_step ** 2);
  }

  #apply_solver_impulse(body: BodyRecord, impulse: Vec3): void {
    if (body.motion !== "dynamic") return;
    body.linear_velocity = vec3_add(
      body.linear_velocity,
      vec3_scale(impulse, body.inverse_mass),
    );
  }

  #apply_contact_impulse(
    body: BodyRecord,
    impulse: Vec3,
    point: Vec3,
  ): void {
    if (body.motion !== "dynamic") return;
    this.#apply_solver_impulse(body, impulse);
    const angular_impulse = vec3_cross(
      vec3_subtract(point, body.pose.position),
      impulse,
    );
    body.angular_velocity = vec3_add(
      body.angular_velocity,
      multiply_components(angular_impulse, body.inverse_inertia),
    );
  }

  #wake(body: BodyRecord): void {
    body.sleeping = false;
    body.still_seconds = 0;
  }

  #query_colliders(filter: PhysicsQueryFilter): ColliderRecord[] {
    if (
      filter.mask !== undefined &&
      (!Number.isSafeInteger(filter.mask) || filter.mask < 0 ||
        filter.mask > 0xffff_ffff)
    ) {
      throw new Error(
        `physics query mask ${
          JSON.stringify(filter.mask)
        } must be unsigned 32-bit`,
      );
    }
    if (
      filter.include_sensors !== undefined &&
      typeof filter.include_sensors !== "boolean"
    ) {
      throw new Error(
        `physics query include-sensors ${
          JSON.stringify(filter.include_sensors)
        } must be boolean`,
      );
    }
    for (const ignored of filter.ignored_bodies ?? []) {
      body_id(ignored.index, ignored.generation);
    }
    for (const ignored of filter.ignored_colliders ?? []) {
      collider_id(ignored.index, ignored.generation);
    }
    const ignored_bodies = new Set(
      (filter.ignored_bodies ?? []).map(physics_id_key),
    );
    const ignored_colliders = new Set(
      (filter.ignored_colliders ?? []).map(physics_id_key),
    );
    const mask = filter.mask ?? 0xffff_ffff;
    return this.#ordered_colliders().filter((collider) =>
      (filter.include_sensors === true || !collider.sensor) &&
      (collider.filter.membership & mask) !== 0 &&
      !ignored_bodies.has(physics_id_key(collider.body)) &&
      !ignored_colliders.has(physics_id_key(collider.id))
    );
  }

  #continuous_fraction(body: BodyRecord, displacement: Vec3): number {
    const distance = vec3_length(displacement);
    const direction = vec3_scale(displacement, 1 / distance);
    let fraction = 1;
    for (const collider of this.#ordered_colliders()) {
      if (!physics_id_equal(collider.body, body.id)) continue;
      const shape = this.#shapes.get(collider.shape.index)!;
      for (
        const target of this.#query_colliders({ ignored_bodies: [body.id] })
      ) {
        const target_body = this.#bodies.get(target.body.index)!;
        const target_shape = this.#shapes.get(target.shape.index)!;
        const hit = sweep_shape_bounds(
          shape.shape,
          compose_rigid_pose(body.pose, collider.local_pose),
          direction,
          distance,
          target_shape.shape,
          compose_rigid_pose(target_body.pose, target.local_pose),
        );
        if (hit !== null) {
          fraction = Math.min(
            fraction,
            Math.max(0, hit.distance / distance - 1e-4),
          );
        }
      }
    }
    return fraction;
  }
}

function freeze_body_state(record: BodyRecord): BodyState {
  return Object.freeze({
    id: record.id,
    motion: record.motion,
    pose: record.pose,
    linear_velocity: record.linear_velocity,
    angular_velocity: record.angular_velocity,
    sleeping: record.sleeping,
  });
}

function freeze_contact(contact: ActiveContact): ContactEvent {
  return Object.freeze({
    first: contact.first,
    second: contact.second,
    first_body: contact.first_body,
    second_body: contact.second_body,
    normal: contact.normal,
    point: contact.point,
    penetration: contact.penetration,
    normal_impulse: contact.accumulated_impulse,
  });
}

function trigger_events(
  previous: ReadonlySet<string>,
  current: ReadonlySet<string>,
  colliders: ReadonlyMap<number, ColliderRecord>,
): TriggerEvent[] {
  const events: TriggerEvent[] = [];
  for (const pair of [...current].sort()) {
    const [first, second] = parse_pair(pair, colliders);
    events.push(
      Object.freeze({
        type: previous.has(pair) ? "stayed" : "entered",
        first,
        second,
      }),
    );
  }
  for (const pair of [...previous].sort()) {
    if (current.has(pair)) continue;
    const [first, second] = parse_pair(pair, colliders);
    events.push(Object.freeze({ type: "exited", first, second }));
  }
  return events;
}

function parse_pair(
  pair: string,
  colliders: ReadonlyMap<number, ColliderRecord>,
): [ColliderId, ColliderId] {
  const [first_key, second_key] = pair.split("|");
  const first_index = Number(first_key.split(":")[0]);
  const second_index = Number(second_key.split(":")[0]);
  return [
    colliders.get(first_index)?.id ??
      collider_id(first_index, Number(first_key.split(":")[1])),
    colliders.get(second_index)?.id ??
      collider_id(second_index, Number(second_key.split(":")[1])),
  ];
}

function filters_collide(
  first: CollisionFilter,
  second: CollisionFilter,
): boolean {
  if (first.group !== 0 && first.group === second.group) return first.group > 0;
  return (first.membership & second.collides_with) !== 0 &&
    (second.membership & first.collides_with) !== 0;
}

function validate_allocator_records(
  allocator: PhysicsAllocatorSnapshot,
  records: readonly {
    readonly id: { readonly index: number; readonly generation: number };
  }[],
  label: string,
): void {
  validate_physics_allocator_snapshot(allocator, label);
  const indices = new Set<number>();
  for (const record of records) {
    const { index, generation } = record.id;
    if (
      !Number.isSafeInteger(index) || index < 0 ||
      index >= allocator.generations.length || indices.has(index) ||
      allocator.occupied[index] !== true ||
      allocator.generations[index] !== generation
    ) {
      throw new Error(
        `physics snapshot ${label} id ${JSON.stringify(index)}:${
          JSON.stringify(generation)
        } is missing, stale, or repeated`,
      );
    }
    indices.add(index);
  }
  const occupied = allocator.occupied.filter(Boolean).length;
  if (indices.size !== occupied) {
    throw new Error(
      `physics snapshot has ${indices.size} ${label} records for ${occupied} occupied allocator entries`,
    );
  }
}

function snapshot_vector(value: Vec3): Vec3 {
  return vec3(value.x, value.y, value.z);
}

function nonnegative_vector(value: Vec3, label: string): Vec3 {
  return vec3(
    nonnegative(value.x, `${label} x`),
    nonnegative(value.y, `${label} y`),
    nonnegative(value.z, `${label} z`),
  );
}

function parse_filter(filter: CollisionFilter): CollisionFilter {
  for (
    const [label, value] of [["membership", filter.membership], [
      "collides_with",
      filter.collides_with,
    ]] as const
  ) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
      throw new Error(
        `collision filter ${label} ${
          JSON.stringify(value)
        } must be an unsigned 32-bit integer`,
      );
    }
  }
  if (
    !Number.isSafeInteger(filter.group) || filter.group < -0x7fff_ffff ||
    filter.group > 0x7fff_ffff
  ) {
    throw new Error(
      `collision filter group ${
        JSON.stringify(filter.group)
      } must be a signed 32-bit integer`,
    );
  }
  return Object.freeze({ ...filter });
}

function parse_material(material: PhysicsMaterial): PhysicsMaterial {
  return Object.freeze({
    friction: nonnegative(material.friction, "material friction"),
    restitution: nonnegative(material.restitution, "material restitution"),
    combination: material.combination,
  });
}

function parse_joint(definition: JointDefinition): JointDefinition {
  const break_force = definition.break_force === undefined
    ? undefined
    : positive(definition.break_force, "joint break force");
  if (definition.type === "distance") {
    const minimum = nonnegative(definition.minimum, "distance joint minimum");
    const maximum = nonnegative(definition.maximum, "distance joint maximum");
    if (minimum > maximum) {
      throw new Error(
        `distance joint minimum ${minimum} exceeds maximum ${maximum}`,
      );
    }
  }
  if (definition.type === "spring") {
    nonnegative(definition.rest_length, "spring rest length");
    positive(definition.stiffness, "spring stiffness");
    nonnegative(definition.damping, "spring damping");
  }
  if (definition.type === "hinge" || definition.type === "slider") {
    if (vec3_length_squared(definition.axis) === 0) {
      throw new Error(`${definition.type} joint axis cannot be zero`);
    }
    if (definition.motor !== undefined) {
      positive(
        definition.motor.maximum_force,
        `${definition.type} motor maximum force`,
      );
    }
    if (
      definition.type === "slider" && definition.minimum > definition.maximum
    ) {
      throw new Error(
        `slider joint minimum ${definition.minimum} exceeds maximum ${definition.maximum}`,
      );
    }
    if (
      definition.type === "hinge" && definition.minimum_angle !== undefined &&
      definition.maximum_angle !== undefined &&
      definition.minimum_angle > definition.maximum_angle
    ) {
      throw new Error(
        `hinge joint minimum angle ${definition.minimum_angle} exceeds maximum ${definition.maximum_angle}`,
      );
    }
    return Object.freeze({
      ...definition,
      axis: vec3_normalize(definition.axis),
      ...(break_force === undefined ? {} : { break_force }),
    }) as JointDefinition;
  }
  return Object.freeze({
    ...definition,
    ...(break_force === undefined ? {} : { break_force }),
  }) as JointDefinition;
}

function combine_coefficient(
  first: number,
  second: number,
  combination: MaterialCombination,
): number {
  switch (combination) {
    case "average":
      return (first + second) / 2;
    case "minimum":
      return Math.min(first, second);
    case "maximum":
      return Math.max(first, second);
    case "multiply":
      return first * second;
  }
}

function integrate_rotation(
  rotation: Quat,
  angular_velocity: Vec3,
  seconds: number,
): Quat {
  const speed = vec3_length(angular_velocity);
  if (speed === 0) return rotation;
  return quat_multiply(
    quat_from_axis_angle(
      vec3_scale(angular_velocity, 1 / speed),
      speed * seconds,
    ),
    rotation,
  );
}

function multiply_components(left: Vec3, right: Vec3): Vec3 {
  return vec3(left.x * right.x, left.y * right.y, left.z * right.z);
}

function pair_key(first: ColliderId, second: ColliderId): string {
  return compare_ids(first, second) <= 0
    ? `${physics_id_key(first)}|${physics_id_key(second)}`
    : `${physics_id_key(second)}|${physics_id_key(first)}`;
}

function body_pair_key(first: BodyId, second: BodyId): string {
  return compare_ids(first, second) <= 0
    ? `${physics_id_key(first)}|${physics_id_key(second)}`
    : `${physics_id_key(second)}|${physics_id_key(first)}`;
}

function compare_ids(
  left: { index: number; generation: number },
  right: { index: number; generation: number },
): number {
  return left.index - right.index || left.generation - right.generation;
}

function compare_query_hits(
  left: PhysicsQueryHit,
  right: PhysicsQueryHit,
): number {
  return left.distance - right.distance ||
    compare_ids(left.collider, right.collider);
}

function count_islands(
  bodies: readonly BodyRecord[],
  contacts: readonly ActiveContact[],
  joints: readonly JointRecord[],
): number {
  const dynamic = bodies.filter((body) => body.motion === "dynamic");
  const parents = new Map(
    dynamic.map((body) => [physics_id_key(body.id), physics_id_key(body.id)]),
  );
  const find = (key: string): string => {
    const parent = parents.get(key);
    if (parent === undefined || parent === key) return key;
    const root = find(parent);
    parents.set(key, root);
    return root;
  };
  const connect = (first: BodyId, second: BodyId) => {
    const first_key = physics_id_key(first);
    const second_key = physics_id_key(second);
    if (!parents.has(first_key) || !parents.has(second_key)) return;
    const first_root = find(first_key);
    const second_root = find(second_key);
    if (first_root !== second_root) parents.set(second_root, first_root);
  };
  for (const contact of contacts) {
    connect(contact.first_body, contact.second_body);
  }
  for (const joint of joints) connect(joint.first, joint.second);
  return new Set([...parents.keys()].map(find)).size;
}

function positive(value: number, label: string): number {
  finite_number(value, label);
  if (value <= 0) throw new Error(`${label} ${value} must be positive`);
  return value;
}

function nonnegative(value: number, label: string): number {
  finite_number(value, label);
  if (value < 0) throw new Error(`${label} ${value} must be nonnegative`);
  return value;
}

function finite(value: number, label: string): number {
  return finite_number(value, label);
}

function positive_integer(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `${label} ${JSON.stringify(value)} must be a positive safe integer`,
    );
  }
  return value;
}
