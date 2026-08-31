import type { Entity } from "./entity.ts";

export interface StoredComponent<value> {
  readonly entity: Entity;
  readonly value: value;
  readonly changed_at: number;
}

export class SparseSet<value> {
  readonly #sparse: Int32Array;
  readonly #entities: number[] = [];
  readonly #values: value[] = [];
  readonly #changed_at: number[] = [];

  constructor(capacity: number) {
    this.#sparse = new Int32Array(capacity);
    this.#sparse.fill(-1);
  }

  get size(): number {
    return this.#entities.length;
  }

  has(index: number): boolean {
    return this.#sparse[index] !== -1;
  }

  get(index: number): value | undefined {
    const dense_index = this.#sparse[index];
    return dense_index === -1 ? undefined : this.#values[dense_index];
  }

  changed_at(index: number): number | undefined {
    const dense_index = this.#sparse[index];
    return dense_index === -1 ? undefined : this.#changed_at[dense_index];
  }

  set(index: number, value: value, changed_at: number): "inserted" | "updated" {
    const dense_index = this.#sparse[index];
    if (dense_index !== -1) {
      this.#values[dense_index] = value;
      this.#changed_at[dense_index] = changed_at;
      return "updated";
    }
    this.#sparse[index] = this.#entities.length;
    this.#entities.push(index);
    this.#values.push(value);
    this.#changed_at.push(changed_at);
    return "inserted";
  }

  remove(index: number): value | undefined {
    const dense_index = this.#sparse[index];
    if (dense_index === -1) return undefined;
    const removed = this.#values[dense_index];
    const last_dense_index = this.#entities.length - 1;
    const last_entity = this.#entities[last_dense_index];
    if (dense_index !== last_dense_index) {
      this.#entities[dense_index] = last_entity;
      this.#values[dense_index] = this.#values[last_dense_index];
      this.#changed_at[dense_index] = this.#changed_at[last_dense_index];
      this.#sparse[last_entity] = dense_index;
    }
    this.#entities.pop();
    this.#values.pop();
    this.#changed_at.pop();
    this.#sparse[index] = -1;
    return removed;
  }

  entity_indices(): readonly number[] {
    return this.#entities.slice();
  }

  clear(): void {
    this.#sparse.fill(-1);
    this.#entities.length = 0;
    this.#values.length = 0;
    this.#changed_at.length = 0;
  }
}
