import type { AssetId } from "@ink/assets/identity.ts";
import type { Observer } from "@ink/observability/observer.ts";
import type { Vec3 } from "@ink/math/vector.ts";
import { vec3 } from "@ink/math/vector.ts";
import {
  create_effect_definition,
  type EffectDefinition,
} from "./definition.ts";
import {
  type GpuCapabilityFallback,
  GpuEffectSimulation,
  type WebGpuSimulationPort,
} from "./gpu.ts";
import type { EffectDefinitionId, EffectInstanceId } from "./identity.ts";
import { effect_definition_id, effect_instance_id } from "./identity.ts";
import type { CollisionPorts } from "./ports.ts";
import {
  CpuEffectSimulation,
  type CpuSimulationOptions,
  type EffectLifecycle,
  type EffectSimulationFrame,
} from "./simulation.ts";

export interface EffectAssetPort {
  available(asset: AssetId): boolean;
}

export type EffectBackend =
  | { readonly type: "cpu" }
  | {
    readonly type: "webgpu";
    readonly executor?: WebGpuSimulationPort;
    readonly unavailable: GpuCapabilityFallback;
  };

export interface StartEffectInstance {
  readonly id: EffectInstanceId;
  readonly definition: EffectDefinitionId;
  readonly seed: number;
  readonly quality: number;
  readonly origin: Vec3;
  readonly backend: EffectBackend;
  readonly collisions?: CollisionPorts;
}

export type PublishEffectResult =
  | { readonly type: "published"; readonly id: EffectDefinitionId }
  | { readonly type: "rejected"; readonly reason: string };

export type ReplaceEffectsResult =
  | {
    readonly type: "replaced";
    readonly definitions: readonly EffectDefinitionId[];
    readonly restarted_instances: readonly EffectInstanceId[];
  }
  | { readonly type: "rejected"; readonly reason: string };

export interface EffectPoolStatistics {
  readonly created: number;
  readonly reused: number;
  readonly available: number;
  readonly pressure: number;
}

type RuntimeSimulation = CpuEffectSimulation | GpuEffectSimulation;

interface RuntimeInstance {
  readonly id: EffectInstanceId;
  definition: EffectDefinitionId;
  readonly backend: EffectBackend;
  readonly seed: number;
  readonly quality: number;
  readonly origin: Vec3;
  readonly collisions?: CollisionPorts;
  simulation: RuntimeSimulation;
  visibility: "visible" | "offscreen";
  offscreen_accumulated_seconds: number;
}

export class EffectRuntime {
  readonly #assets: EffectAssetPort;
  readonly #observer: Observer | undefined;
  readonly #definitions = new Map<EffectDefinitionId, EffectDefinition>();
  readonly #instances = new Map<EffectInstanceId, RuntimeInstance>();
  readonly #cpu_pool: CpuEffectSimulation[] = [];
  #pool_created = 0;
  #pool_reused = 0;
  #pool_peak_checked_out = 0;

  constructor(assets: EffectAssetPort, observer?: Observer) {
    this.#assets = assets;
    this.#observer = observer;
  }

  publish(definition: EffectDefinition): PublishEffectResult {
    definition = create_effect_definition(definition);
    if (this.#definitions.has(definition.id)) {
      return {
        type: "rejected",
        reason:
          `effect ${definition.id} is already published; use replacement for a new revision`,
      };
    }
    const unavailable = definition.required_assets.find((asset) =>
      !this.#assets.available(asset)
    );
    if (unavailable !== undefined) {
      return {
        type: "rejected",
        reason:
          `effect ${definition.id} requires unavailable asset ${unavailable}`,
      };
    }
    this.#definitions.set(definition.id, definition);
    return { type: "published", id: definition.id };
  }

  start(input: StartEffectInstance): EffectSimulationFrame {
    const id = effect_instance_id(input.id);
    const definition_id = effect_definition_id(input.definition);
    if (this.#instances.has(id)) {
      throw new Error(`effect instance ${id} already exists`);
    }
    const definition = this.#definitions.get(definition_id);
    if (definition === undefined) {
      throw new Error(
        `effect instance ${id} references unpublished definition ${definition_id}`,
      );
    }
    this.#assert_assets(definition, id);
    const backend_type = input.backend.type as string;
    if (backend_type !== "cpu" && backend_type !== "webgpu") {
      throw new Error(
        `effect instance ${id} backend ${
          JSON.stringify(backend_type)
        } is unsupported`,
      );
    }
    if (
      input.backend.type === "webgpu" &&
      !["cpu", "reduced", "stopped"].includes(input.backend.unavailable)
    ) {
      throw new Error(
        `effect instance ${id} GPU fallback ${
          JSON.stringify(input.backend.unavailable)
        } is unsupported`,
      );
    }
    const origin = vec3(input.origin.x, input.origin.y, input.origin.z);
    const options: CpuSimulationOptions = {
      instance: id,
      definition,
      seed: input.seed,
      quality: input.quality,
      origin,
      collisions: input.collisions,
      observer: this.#observer,
    };
    const simulation = input.backend.type === "cpu"
      ? this.#acquire_cpu(options)
      : new GpuEffectSimulation({
        ...options,
        executor: input.backend.executor,
        unavailable: input.backend.unavailable,
      });
    this.#instances.set(id, {
      ...input,
      id,
      definition: definition_id,
      origin,
      simulation,
      visibility: "visible",
      offscreen_accumulated_seconds: 0,
    });
    this.#pool_peak_checked_out = Math.max(
      this.#pool_peak_checked_out,
      this.#cpu_checked_out(),
    );
    this.#observer?.event("visual_effect.instance.started", {
      instance_id: input.id,
      definition_id: definition.id,
      backend: input.backend.type,
      quality: input.quality,
    });
    return simulation instanceof CpuEffectSimulation
      ? simulation.snapshot()
      : simulation.snapshot();
  }

  set_visibility(
    id: EffectInstanceId,
    visibility: RuntimeInstance["visibility"],
  ): void {
    const instance = this.#required_instance(id);
    instance.visibility = visibility;
  }

  stop(id: EffectInstanceId): void {
    this.#required_instance(id).simulation.stop();
  }

  destroy(id: EffectInstanceId): void {
    const instance = this.#required_instance(id);
    if (instance.simulation instanceof CpuEffectSimulation) {
      instance.simulation.finish();
      this.#cpu_pool.push(instance.simulation);
    }
    this.#instances.delete(id);
    this.#observe_pool();
  }

  step(delta_seconds: number): readonly EffectSimulationFrame[] {
    if (!Number.isFinite(delta_seconds) || delta_seconds < 0) {
      throw new Error(
        `visual effect runtime step ${delta_seconds} must be finite and nonnegative`,
      );
    }
    const frames: EffectSimulationFrame[] = [];
    for (
      const instance of [...this.#instances.values()].sort((left, right) =>
        left.id.localeCompare(right.id)
      )
    ) {
      const definition = this.#definitions.get(instance.definition)!;
      if (
        instance.visibility === "visible" || definition.offscreen === "simulate"
      ) {
        frames.push(instance.simulation.step(delta_seconds));
        continue;
      }
      if (definition.offscreen === "pause") {
        frames.push(this.#snapshot(instance));
        continue;
      }
      instance.offscreen_accumulated_seconds += delta_seconds;
      if (instance.offscreen_accumulated_seconds < 1 / 15) {
        frames.push(this.#snapshot(instance));
        continue;
      }
      frames.push(
        instance.simulation.step(instance.offscreen_accumulated_seconds),
      );
      instance.offscreen_accumulated_seconds = 0;
    }
    return Object.freeze(frames);
  }

  replace(definitions: readonly EffectDefinition[]): ReplaceEffectsResult {
    let ordered: EffectDefinition[];
    try {
      ordered = definitions.map(create_effect_definition).sort((left, right) =>
        left.id.localeCompare(right.id)
      );
    } catch (error) {
      return this.#replacement_rejected(
        `replacement definition is invalid: ${message(error)}`,
      );
    }
    const ids = new Set<EffectDefinitionId>();
    for (const candidate of ordered) {
      if (ids.has(candidate.id)) {
        return this.#replacement_rejected(
          `replacement batch repeats effect ${candidate.id}`,
        );
      }
      ids.add(candidate.id);
      const current = this.#definitions.get(candidate.id);
      if (current === undefined) {
        return this.#replacement_rejected(
          `replacement effect ${candidate.id} is not currently published`,
        );
      }
      if (candidate.revision <= current.revision) {
        return this.#replacement_rejected(
          `replacement effect ${candidate.id} revision ${candidate.revision} must exceed current revision ${current.revision}`,
        );
      }
      const unavailable = candidate.required_assets.find((asset) =>
        !this.#assets.available(asset)
      );
      if (unavailable !== undefined) {
        return this.#replacement_rejected(
          `replacement effect ${candidate.id} requires unavailable asset ${unavailable}`,
        );
      }
    }
    for (const instance of this.#instances.values()) {
      const replacement = ordered.find((candidate) =>
        candidate.id === instance.definition
      );
      if (replacement === undefined) continue;
      try {
        new CpuEffectSimulation(this.#cpu_options(instance, replacement));
      } catch (error) {
        return this.#replacement_rejected(
          `replacement effect ${replacement.id} invalidates instance ${instance.id}: ${
            message(error)
          }`,
        );
      }
    }
    for (const definition of ordered) {
      this.#definitions.set(definition.id, definition);
    }
    const restarted: EffectInstanceId[] = [];
    for (const instance of this.#instances.values()) {
      const replacement = ordered.find((candidate) =>
        candidate.id === instance.definition
      );
      if (replacement === undefined) continue;
      if (instance.simulation instanceof CpuEffectSimulation) {
        instance.simulation.reset(this.#cpu_options(instance, replacement));
      } else {
        instance.simulation.replace_definition(replacement, instance.quality);
      }
      restarted.push(instance.id);
    }
    restarted.sort();
    return {
      type: "replaced",
      definitions: Object.freeze(ordered.map((definition) => definition.id)),
      restarted_instances: Object.freeze(restarted),
    };
  }

  device_lost(reason: string): void {
    for (const instance of this.#instances.values()) {
      if (instance.simulation instanceof GpuEffectSimulation) {
        instance.simulation.device_lost(reason);
      }
    }
  }

  lifecycle(id: EffectInstanceId): EffectLifecycle {
    return this.#required_instance(id).simulation.lifecycle();
  }

  pool_statistics(): EffectPoolStatistics {
    const checked_out = this.#cpu_checked_out();
    return Object.freeze({
      created: this.#pool_created,
      reused: this.#pool_reused,
      available: this.#cpu_pool.length,
      pressure: this.#pool_peak_checked_out === 0
        ? 0
        : checked_out / this.#pool_peak_checked_out,
    });
  }

  #acquire_cpu(options: CpuSimulationOptions): CpuEffectSimulation {
    const simulation = this.#cpu_pool.pop();
    if (simulation === undefined) {
      this.#pool_created += 1;
      return new CpuEffectSimulation(options);
    }
    this.#pool_reused += 1;
    simulation.reset(options);
    return simulation;
  }

  #snapshot(instance: RuntimeInstance): EffectSimulationFrame {
    return instance.simulation instanceof CpuEffectSimulation
      ? instance.simulation.snapshot()
      : instance.simulation.snapshot();
  }

  #cpu_options(
    instance: RuntimeInstance,
    definition: EffectDefinition,
  ): CpuSimulationOptions {
    return {
      instance: instance.id,
      definition,
      seed: instance.seed,
      quality: instance.quality,
      origin: instance.origin,
      collisions: instance.collisions,
      observer: this.#observer,
    };
  }

  #assert_assets(
    definition: EffectDefinition,
    instance: EffectInstanceId,
  ): void {
    const unavailable = definition.required_assets.find((asset) =>
      !this.#assets.available(asset)
    );
    if (unavailable !== undefined) {
      throw new Error(
        `effect instance ${instance} cannot start because required asset ${unavailable} is unavailable`,
      );
    }
  }

  #required_instance(id: EffectInstanceId): RuntimeInstance {
    const instance = this.#instances.get(id);
    if (instance === undefined) {
      throw new Error(`effect instance ${id} does not exist`);
    }
    return instance;
  }

  #cpu_checked_out(): number {
    return [...this.#instances.values()].filter((instance) =>
      instance.simulation instanceof CpuEffectSimulation
    ).length;
  }

  #observe_pool(): void {
    const statistics = this.pool_statistics();
    this.#observer?.gauge(
      "visual_effect.pool_pressure",
      statistics.pressure,
      "ratio",
    );
    this.#observer?.gauge(
      "visual_effect.pool_available",
      statistics.available,
      "count",
    );
  }

  #replacement_rejected(reason: string): ReplaceEffectsResult {
    this.#observer?.diagnostic(
      "warning",
      "visual_effect.replacement_rejected",
      reason,
      {},
    );
    return { type: "rejected", reason };
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
