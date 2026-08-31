import type { Observer } from "@ink/observability/observer.ts";
import {
  apply_material_overrides,
  canonical_material_record,
  create_material_definition,
} from "../canonical.ts";
import {
  material_definition_id,
  material_instance_id,
  material_variant_id,
  type MaterialDefinitionId,
  type MaterialInstanceId,
  type MaterialVariantId,
} from "../identity.ts";
import type {
  CanonicalMaterialRecord,
  MaterialCapabilities,
  MaterialDefinition,
  MaterialInstance,
  MaterialParameterOverrides,
} from "../model.ts";

export type MaterialPublishResult =
  | { readonly type: "published"; readonly id: MaterialDefinitionId }
  | { readonly type: "rejected"; readonly reason: string };

export type MaterialReplacementResult =
  | {
    readonly type: "replaced";
    readonly definitions: readonly MaterialDefinitionId[];
    readonly instances: readonly MaterialInstanceId[];
  }
  | { readonly type: "rejected"; readonly reason: string };

export interface CreateMaterialInstance {
  readonly id: MaterialInstanceId;
  readonly definition: MaterialDefinitionId;
  readonly variant?: MaterialVariantId;
  readonly overrides?: MaterialParameterOverrides;
}

export interface UpdateMaterialInstance {
  readonly overrides?: MaterialParameterOverrides;
  readonly variant?: MaterialVariantId | null;
}

export class MaterialLibrary {
  readonly #observer: Observer | undefined;
  readonly #definitions = new Map<MaterialDefinitionId, MaterialDefinition>();
  readonly #instances = new Map<MaterialInstanceId, MaterialInstance>();

  constructor(observer?: Observer) {
    this.#observer = observer;
  }

  definition(id: MaterialDefinitionId): MaterialDefinition | undefined {
    return this.#definitions.get(id);
  }

  instance(id: MaterialInstanceId): MaterialInstance | undefined {
    return this.#instances.get(id);
  }

  counts(): { readonly definitions: number; readonly instances: number } {
    return Object.freeze({
      definitions: this.#definitions.size,
      instances: this.#instances.size,
    });
  }

  publish(definition: MaterialDefinition): MaterialPublishResult {
    let parsed: MaterialDefinition;
    try {
      parsed = create_material_definition(definition);
    } catch (error) {
      return {
        type: "rejected",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (this.#definitions.has(parsed.id)) {
      return {
        type: "rejected",
        reason:
          `material ${parsed.id} is already published; use replacement for a new revision`,
      };
    }
    this.#definitions.set(parsed.id, parsed);
    this.#observer?.event("material.definition.published", {
      material_id: parsed.id,
      revision: parsed.revision,
      feature_key: parsed.features.join("+") || "base",
      definition_count: this.#definitions.size,
      instance_count: this.#instances.size,
    });
    return { type: "published", id: parsed.id };
  }

  create_instance(input: CreateMaterialInstance): MaterialInstance {
    if (material_instance_id(input.id) !== input.id) {
      throw new Error(
        `material instance identity ${input.id} is not canonical`,
      );
    }
    if (this.#instances.has(input.id)) {
      throw new Error(`material instance ${input.id} already exists`);
    }
    if (material_definition_id(input.definition) !== input.definition) {
      throw new Error(
        `material definition identity ${input.definition} is not canonical`,
      );
    }
    if (
      input.variant !== undefined &&
      material_variant_id(input.variant) !== input.variant
    ) {
      throw new Error(
        `material variant identity ${input.variant} is not canonical`,
      );
    }
    const definition = this.#definitions.get(input.definition);
    if (definition === undefined) {
      throw new Error(
        `material instance ${input.id} references unavailable definition ${input.definition}`,
      );
    }
    this.#validate_variant(definition, input.variant, input.id);
    const overrides = input.overrides ?? {};
    apply_material_overrides(definition, overrides);
    const instance = immutable_instance({
      id: input.id,
      definition: definition.id,
      definition_revision: definition.revision,
      revision: 0,
      ...(input.variant === undefined ? {} : { variant: input.variant }),
      overrides,
    });
    this.#instances.set(instance.id, instance);
    this.#observer?.event("material.instance.created", {
      instance_id: instance.id,
      material_id: instance.definition,
      revision: instance.revision,
      definition_count: this.#definitions.size,
      instance_count: this.#instances.size,
    });
    return instance;
  }

  update_instance(
    id: MaterialInstanceId,
    update: UpdateMaterialInstance,
  ): MaterialInstance {
    const current = this.#instances.get(id);
    if (current === undefined) {
      throw new Error(`material instance ${id} does not exist`);
    }
    if (current.revision === Number.MAX_SAFE_INTEGER) {
      throw new Error(`material instance ${id} revision cannot advance safely`);
    }
    const definition = this.#definitions.get(current.definition)!;
    const variant = update.variant === null
      ? undefined
      : update.variant ?? current.variant;
    this.#validate_variant(definition, variant, id);
    const overrides = update.overrides ?? current.overrides;
    apply_material_overrides(definition, overrides);
    const next = immutable_instance({
      ...current,
      revision: current.revision + 1,
      ...(variant === undefined ? { variant: undefined } : { variant }),
      overrides,
    });
    this.#instances.set(id, next);
    this.#observer?.event("material.instance.updated", {
      instance_id: id,
      material_id: next.definition,
      revision: next.revision,
    });
    return next;
  }

  replace(
    definitions: readonly MaterialDefinition[],
  ): MaterialReplacementResult {
    let parsed: MaterialDefinition[];
    try {
      parsed = definitions.map(create_material_definition);
    } catch (error) {
      return this.#replacement_rejected(
        error instanceof Error ? error.message : String(error),
      );
    }
    const ordered = parsed.sort((left, right) =>
      left.id.localeCompare(right.id)
    );
    const ids = new Set<MaterialDefinitionId>();
    for (const candidate of ordered) {
      if (ids.has(candidate.id)) {
        return this.#replacement_rejected(
          `replacement batch repeats material ${candidate.id}`,
        );
      }
      ids.add(candidate.id);
      const current = this.#definitions.get(candidate.id);
      if (current === undefined) {
        return this.#replacement_rejected(
          `replacement material ${candidate.id} is not currently published`,
        );
      }
      if (candidate.revision <= current.revision) {
        return this.#replacement_rejected(
          `replacement material ${candidate.id} revision ${candidate.revision} must exceed current revision ${current.revision}`,
        );
      }
    }
    const affected = [...this.#instances.values()].filter((instance) =>
      ids.has(instance.definition)
    );
    for (const instance of affected) {
      const candidate = ordered.find((definition) =>
        definition.id === instance.definition
      )!;
      try {
        this.#validate_variant(candidate, instance.variant, instance.id);
        apply_material_overrides(candidate, instance.overrides);
      } catch (error) {
        return this.#replacement_rejected(
          `replacement material ${candidate.id} invalidates instance ${instance.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    for (const candidate of ordered) {
      this.#definitions.set(candidate.id, candidate);
    }
    const updated_instances: MaterialInstanceId[] = [];
    for (const current of affected) {
      const definition = this.#definitions.get(current.definition)!;
      const next = immutable_instance({
        ...current,
        definition_revision: definition.revision,
        revision: current.revision + 1,
      });
      this.#instances.set(next.id, next);
      updated_instances.push(next.id);
    }
    const definition_ids = Object.freeze(ordered.map(({ id }) => id));
    updated_instances.sort();
    this.#observer?.event("material.definition.replaced", {
      definition_count: definition_ids.length,
      instance_count: updated_instances.length,
      library_definition_count: this.#definitions.size,
      library_instance_count: this.#instances.size,
    });
    return {
      type: "replaced",
      definitions: definition_ids,
      instances: Object.freeze(updated_instances),
    };
  }

  canonical_record(
    id: MaterialInstanceId,
    capabilities?: MaterialCapabilities,
  ): CanonicalMaterialRecord {
    const instance = this.#instances.get(id);
    if (instance === undefined) {
      throw new Error(`material instance ${id} does not exist`);
    }
    const record = canonical_material_record(
      this.#definitions.get(instance.definition)!,
      instance,
      capabilities,
    );
    this.#observer?.event("material.record.resolved", {
      instance_id: id,
      material_id: record.definition,
      feature_key: record.feature_key,
      requested_variant: instance.variant ?? "base",
      selected_variant: record.variant ?? "base",
    });
    return record;
  }

  #validate_variant(
    definition: MaterialDefinition,
    variant: MaterialVariantId | undefined,
    instance: MaterialInstanceId,
  ): void {
    if (
      variant !== undefined &&
      !definition.variants.some((candidate) => candidate.id === variant)
    ) {
      throw new Error(
        `material instance ${instance} requests missing variant ${variant} from ${definition.id}`,
      );
    }
  }

  #replacement_rejected(reason: string): MaterialReplacementResult {
    this.#observer?.event("material.definition.replacement_failed", { reason });
    return { type: "rejected", reason };
  }
}

function immutable_instance(instance: MaterialInstance): MaterialInstance {
  const clone = structuredClone(instance);
  const freeze = (current: unknown): void => {
    if (
      current === null || typeof current !== "object" ||
      Object.isFrozen(current)
    ) return;
    for (const property of Object.values(current)) freeze(property);
    Object.freeze(current);
  };
  freeze(clone);
  return Object.freeze(clone);
}
