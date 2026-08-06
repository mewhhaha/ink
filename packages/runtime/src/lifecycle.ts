import { Observer } from "@ink/observability/observer.ts";
import { parse_identity } from "./artifact.ts";
import type { FixedStepContext, FrameContext } from "./frame.ts";
import {
  type Block,
  type BlockInstance,
  type Capability,
  type CapabilityLease,
  type GameGuest,
  resolve_runtime_graph,
  type RuntimeGraph,
} from "./graph.ts";

export type RuntimeLifecycleState =
  | "created"
  | "initializing"
  | "initialized"
  | "starting"
  | "running"
  | "closing"
  | "closed";

export interface RuntimeLifecycleOptions {
  readonly guest: GameGuest;
  readonly capabilities: readonly Capability[];
  readonly observer: Observer;
}

interface AcquiredBlock {
  readonly block: Block;
  readonly instance: BlockInstance;
}

interface AcquiredCapability {
  readonly id: string;
  readonly lease: CapabilityLease;
}

export class RuntimeLifecycle {
  readonly #guest: GameGuest;
  readonly #graph: RuntimeGraph;
  readonly #providers: ReadonlyMap<string, Capability>;
  readonly #observer: Observer;
  readonly #capability_values = new Map<string, unknown>();
  readonly #acquired_capabilities: AcquiredCapability[] = [];
  readonly #acquired_blocks: AcquiredBlock[] = [];
  #state: RuntimeLifecycleState = "created";
  #close_operation: Promise<void> | undefined;

  constructor(options: RuntimeLifecycleOptions) {
    this.#guest = options.guest;
    this.#graph = resolve_runtime_graph(options.guest);
    this.#providers = parse_capability_providers(
      options.capabilities,
      options.guest.artifact.guest_id,
    );
    this.#observer = options.observer;
    validate_block_capabilities(this.#guest, this.#graph);
  }

  get state(): RuntimeLifecycleState {
    return this.#state;
  }

  async initialize(): Promise<void> {
    this.#require_state("created", "initialize");
    this.#state = "initializing";
    this.#observer.event("runtime.initialize.started", this.#evidence());
    try {
      await this.#acquire_capabilities();
      await this.#acquire_and_initialize_blocks();
      this.#state = "initialized";
      this.#observer.event("runtime.initialize.completed", this.#evidence());
    } catch (error) {
      await this.#close_after_failure("initialize", error);
    }
  }

  async start(): Promise<void> {
    this.#require_state("initialized", "start");
    this.#state = "starting";
    this.#observer.event("runtime.start.started", this.#evidence());
    try {
      for (const acquired of this.#acquired_blocks) {
        await this.#run_block_phase(
          acquired,
          "start",
          () => acquired.instance.start?.(),
        );
      }
      this.#state = "running";
      this.#observer.event("runtime.start.completed", this.#evidence());
    } catch (error) {
      await this.#close_after_failure("start", error);
    }
  }

  async fixed_step(context: FixedStepContext): Promise<void> {
    this.#require_state("running", "fixed_step");
    try {
      for (const acquired of this.#acquired_blocks) {
        await this.#run_block_phase(
          acquired,
          "fixed_step",
          () => acquired.instance.fixed_step?.(context),
        );
      }
    } catch (error) {
      await this.#close_after_failure("fixed_step", error);
    }
  }

  async frame(context: FrameContext): Promise<void> {
    this.#require_state("running", "frame");
    try {
      for (const acquired of this.#acquired_blocks) {
        await this.#run_block_phase(
          acquired,
          "frame",
          () => acquired.instance.frame?.(context),
        );
      }
    } catch (error) {
      await this.#close_after_failure("frame", error);
    }
  }

  close(): Promise<void> {
    if (this.#close_operation !== undefined) return this.#close_operation;
    this.#state = "closing";
    this.#close_operation = this.#release_resources();
    return this.#close_operation;
  }

  async #acquire_capabilities(): Promise<void> {
    for (const declaration of this.#guest.artifact.capabilities) {
      const provider = this.#providers.get(declaration.id);
      if (provider === undefined) {
        if (declaration.availability === "optional") {
          this.#observer.event("runtime.capability.unavailable", {
            ...this.#evidence(),
            capability: declaration.id,
            reason: "provider missing",
          });
          continue;
        }
        throw new Error(
          `guest ${JSON.stringify(this.#guest.artifact.guest_id)} artifact ${
            JSON.stringify(this.#guest.artifact.artifact_digest)
          } requires unavailable capability ${JSON.stringify(declaration.id)}`,
        );
      }
      let lease: CapabilityLease;
      try {
        lease = await provider.acquire({
          guest_id: this.#guest.artifact.guest_id,
          artifact_digest: this.#guest.artifact.artifact_digest,
        });
      } catch (error) {
        if (declaration.availability === "optional") {
          this.#observer.diagnostic(
            "warning",
            "runtime.capability.acquire",
            `optional capability ${
              JSON.stringify(declaration.id)
            } failed to acquire`,
            {
              ...this.#evidence(),
              capability: declaration.id,
              reason: error_reason(error),
            },
          );
          continue;
        }
        throw phase_error(
          this.#guest.artifact.guest_id,
          this.#guest.artifact.artifact_digest,
          `capability ${JSON.stringify(declaration.id)}`,
          "acquire",
          error,
        );
      }
      if (
        typeof lease !== "object" || lease === null ||
        typeof lease.release !== "function"
      ) {
        throw new Error(
          `guest ${JSON.stringify(this.#guest.artifact.guest_id)} capability ${
            JSON.stringify(declaration.id)
          } returned a lease without release()`,
        );
      }
      this.#acquired_capabilities.push({ id: declaration.id, lease });
      this.#capability_values.set(declaration.id, lease.value);
      this.#observer.event("runtime.capability.acquired", {
        ...this.#evidence(),
        capability: declaration.id,
      });
    }
  }

  async #acquire_and_initialize_blocks(): Promise<void> {
    for (const block of this.#graph.blocks) {
      let instance: BlockInstance;
      try {
        instance = await block.acquire({
          guest_id: this.#guest.artifact.guest_id,
          capabilities: this.#capability_values,
        });
      } catch (error) {
        throw phase_error(
          this.#guest.artifact.guest_id,
          this.#guest.artifact.artifact_digest,
          `block ${JSON.stringify(block.id)}`,
          "acquire",
          error,
        );
      }
      if (typeof instance !== "object" || instance === null) {
        throw new Error(
          `guest ${JSON.stringify(this.#guest.artifact.guest_id)} block ${
            JSON.stringify(block.id)
          } acquire returned ${String(instance)} instead of a block instance`,
        );
      }
      const acquired = { block, instance };
      this.#acquired_blocks.push(acquired);
      await this.#run_block_phase(
        acquired,
        "initialize",
        () => instance.initialize?.(),
      );
    }
  }

  async #run_block_phase(
    acquired: AcquiredBlock,
    phase: string,
    run: () => unknown | Promise<unknown>,
  ): Promise<void> {
    try {
      await run();
    } catch (error) {
      throw phase_error(
        this.#guest.artifact.guest_id,
        this.#guest.artifact.artifact_digest,
        `block ${JSON.stringify(acquired.block.id)}`,
        phase,
        error,
      );
    }
  }

  async #close_after_failure(phase: string, failure: unknown): Promise<never> {
    this.#observer.diagnostic(
      "error",
      `runtime.${phase}`,
      `runtime ${phase} failed`,
      { ...this.#evidence(), reason: error_reason(failure) },
    );
    try {
      await this.close();
    } catch (cleanup_failure) {
      throw new AggregateError(
        [failure, cleanup_failure],
        `guest ${
          JSON.stringify(this.#guest.artifact.guest_id)
        } ${phase} failed and cleanup also failed`,
      );
    }
    throw failure;
  }

  async #release_resources(): Promise<void> {
    this.#observer.event("runtime.close.started", this.#evidence());
    const failures: Error[] = [];
    while (this.#acquired_blocks.length > 0) {
      const acquired = this.#acquired_blocks.pop()!;
      try {
        await acquired.instance.close?.();
      } catch (error) {
        const failure = phase_error(
          this.#guest.artifact.guest_id,
          this.#guest.artifact.artifact_digest,
          `block ${JSON.stringify(acquired.block.id)}`,
          "close",
          error,
        );
        failures.push(failure);
        this.#observer.diagnostic(
          "error",
          "runtime.block.close",
          failure.message,
          {
            ...this.#evidence(),
            block: acquired.block.id,
            reason: error_reason(error),
          },
        );
      }
    }
    while (this.#acquired_capabilities.length > 0) {
      const acquired = this.#acquired_capabilities.pop()!;
      this.#capability_values.delete(acquired.id);
      try {
        await acquired.lease.release();
      } catch (error) {
        const failure = phase_error(
          this.#guest.artifact.guest_id,
          this.#guest.artifact.artifact_digest,
          `capability ${JSON.stringify(acquired.id)}`,
          "release",
          error,
        );
        failures.push(failure);
        this.#observer.diagnostic(
          "error",
          "runtime.capability.release",
          failure.message,
          {
            ...this.#evidence(),
            capability: acquired.id,
            reason: error_reason(error),
          },
        );
      }
    }
    this.#state = "closed";
    this.#observer.event("runtime.close.completed", {
      ...this.#evidence(),
      cleanup_failures: failures.length,
    });
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `guest ${
          JSON.stringify(this.#guest.artifact.guest_id)
        } cleanup failed for ${failures.length} resource(s)`,
      );
    }
  }

  #require_state(expected: RuntimeLifecycleState, operation: string): void {
    if (this.#state !== expected) {
      throw new Error(
        `guest ${
          JSON.stringify(this.#guest.artifact.guest_id)
        } cannot ${operation} while runtime is ${this.#state}; expected ${expected}`,
      );
    }
  }

  #evidence(): Readonly<Record<string, string | number>> {
    return {
      guest: this.#guest.artifact.guest_id,
      artifact_digest: this.#guest.artifact.artifact_digest,
    };
  }
}

function parse_capability_providers(
  capabilities: readonly Capability[],
  guest_id: string,
): ReadonlyMap<string, Capability> {
  const providers = new Map<string, Capability>();
  for (const [index, capability] of capabilities.entries()) {
    const id = parse_identity(
      capability.id,
      `guest ${JSON.stringify(guest_id)} capability provider ${index} id`,
    );
    if (providers.has(id)) {
      throw new Error(
        `guest ${
          JSON.stringify(guest_id)
        } has more than one provider for capability ${JSON.stringify(id)}`,
      );
    }
    providers.set(id, capability);
  }
  return providers;
}

function validate_block_capabilities(
  guest: GameGuest,
  graph: RuntimeGraph,
): void {
  const declared = new Set(guest.artifact.capabilities.map(({ id }) => id));
  for (const block of graph.blocks) {
    for (const capability of block.capabilities) {
      if (!declared.has(capability)) {
        throw new Error(
          `guest ${JSON.stringify(guest.artifact.guest_id)} block ${
            JSON.stringify(block.id)
          } requests undeclared capability ${JSON.stringify(capability)}`,
        );
      }
    }
  }
}

function phase_error(
  guest_id: string,
  artifact_digest: string,
  owner: string,
  phase: string,
  cause: unknown,
): Error {
  return new Error(
    `guest ${JSON.stringify(guest_id)} artifact ${
      JSON.stringify(artifact_digest)
    } ${owner} failed during ${phase}: ${error_reason(cause)}`,
    { cause },
  );
}

function error_reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
