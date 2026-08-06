declare const physics_world_id_brand: unique symbol;
declare const shape_id_brand: unique symbol;
declare const body_id_brand: unique symbol;
declare const collider_id_brand: unique symbol;
declare const joint_id_brand: unique symbol;

export type PhysicsWorldId = string & {
  readonly [physics_world_id_brand]: true;
};

export interface ShapeId {
  readonly index: number;
  readonly generation: number;
  readonly [shape_id_brand]: true;
}

export interface BodyId {
  readonly index: number;
  readonly generation: number;
  readonly [body_id_brand]: true;
}

export interface ColliderId {
  readonly index: number;
  readonly generation: number;
  readonly [collider_id_brand]: true;
}

export interface JointId {
  readonly index: number;
  readonly generation: number;
  readonly [joint_id_brand]: true;
}

export type PhysicsId = ShapeId | BodyId | ColliderId | JointId;

export function physics_world_id(source: string): PhysicsWorldId {
  const id = source.trim();
  if (id.length === 0) {
    throw new Error(
      `physics world id ${JSON.stringify(source)} cannot be empty`,
    );
  }
  return id as PhysicsWorldId;
}

export function shape_id(index: number, generation: number): ShapeId {
  return physics_id(index, generation, "shape") as ShapeId;
}

export function body_id(index: number, generation: number): BodyId {
  return physics_id(index, generation, "body") as BodyId;
}

export function collider_id(index: number, generation: number): ColliderId {
  return physics_id(index, generation, "collider") as ColliderId;
}

export function joint_id(index: number, generation: number): JointId {
  return physics_id(index, generation, "joint") as JointId;
}

export function physics_id_key(id: PhysicsId): string {
  return `${id.index}:${id.generation}`;
}

export function physics_id_equal(left: PhysicsId, right: PhysicsId): boolean {
  return left.index === right.index && left.generation === right.generation;
}

function physics_id(
  index: number,
  generation: number,
  kind: string,
): Readonly<{ index: number; generation: number }> {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error(
      `physics ${kind} index ${
        JSON.stringify(index)
      } must be a nonnegative safe integer`,
    );
  }
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error(
      `physics ${kind} generation ${
        JSON.stringify(generation)
      } must be a nonnegative safe integer`,
    );
  }
  return Object.freeze({ index, generation });
}

export class PhysicsIdAllocator<Id extends PhysicsId> {
  readonly #create: (index: number, generation: number) => Id;
  readonly #generations: number[] = [];
  readonly #occupied: boolean[] = [];
  readonly #free_indices: number[] = [];

  constructor(create: (index: number, generation: number) => Id) {
    this.#create = create;
  }

  allocate(): Id {
    const index = this.#free_indices.shift() ?? this.#generations.length;
    if (index === this.#generations.length) {
      this.#generations.push(0);
      this.#occupied.push(true);
    } else {
      this.#occupied[index] = true;
    }
    return this.#create(index, this.#generations[index]);
  }

  contains(id: Id): boolean {
    return this.#occupied[id.index] === true &&
      this.#generations[id.index] === id.generation;
  }

  retire(id: Id): boolean {
    if (!this.contains(id)) return false;
    this.#occupied[id.index] = false;
    this.#generations[id.index] += 1;
    this.#free_indices.push(id.index);
    this.#free_indices.sort((left, right) => left - right);
    return true;
  }

  snapshot(): PhysicsAllocatorSnapshot {
    return Object.freeze({
      generations: Object.freeze([...this.#generations]),
      occupied: Object.freeze([...this.#occupied]),
      free_indices: Object.freeze([...this.#free_indices]),
    });
  }

  restore(snapshot: PhysicsAllocatorSnapshot): void {
    this.#generations.splice(
      0,
      this.#generations.length,
      ...snapshot.generations,
    );
    this.#occupied.splice(0, this.#occupied.length, ...snapshot.occupied);
    this.#free_indices.splice(
      0,
      this.#free_indices.length,
      ...snapshot.free_indices,
    );
  }
}

export interface PhysicsAllocatorSnapshot {
  readonly generations: readonly number[];
  readonly occupied: readonly boolean[];
  readonly free_indices: readonly number[];
}
