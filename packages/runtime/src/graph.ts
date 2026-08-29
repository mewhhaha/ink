import type { GameArtifact } from "./artifact.ts";
import { parse_identity } from "./artifact.ts";
import type { FixedStepContext, FrameContext } from "./frame.ts";

export type Awaitable<T> = T | Promise<T>;

export interface CapabilityLease {
  readonly value: unknown;
  release(): Awaitable<void>;
}

export interface CapabilityAcquireContext {
  readonly guest_id: string;
  readonly artifact_digest: string;
}

export interface Capability {
  readonly id: string;
  acquire(context: CapabilityAcquireContext): Awaitable<CapabilityLease>;
}

export interface BlockAcquireContext {
  readonly guest_id: string;
  readonly capabilities: ReadonlyMap<string, unknown>;
}

export interface BlockInstance {
  initialize?(): Awaitable<void>;
  start?(): Awaitable<void>;
  fixed_step?(context: FixedStepContext): Awaitable<void>;
  frame?(context: FrameContext): Awaitable<void>;
  close?(): Awaitable<void>;
}

export interface Block {
  readonly id: string;
  readonly dependencies: readonly string[];
  readonly capabilities: readonly string[];
  acquire(context: BlockAcquireContext): Awaitable<BlockInstance>;
}

export interface RuntimeGuestStructure {
  readonly artifact: GameArtifact;
  readonly blocks: readonly Block[];
}

export interface RuntimeGraph {
  readonly guest_id: string;
  readonly blocks: readonly Block[];
}

export function resolve_runtime_graph(
  guest: RuntimeGuestStructure,
): RuntimeGraph {
  const blocks = new Map<string, Block>();
  for (const [index, block] of guest.blocks.entries()) {
    const id = parse_identity(
      block.id,
      `guest ${JSON.stringify(guest.artifact.guest_id)} block ${index} id`,
    );
    if (blocks.has(id)) {
      throw new Error(
        `guest ${JSON.stringify(guest.artifact.guest_id)} artifact ${
          JSON.stringify(guest.artifact.artifact_digest)
        } declares block ${JSON.stringify(id)} more than once`,
      );
    }
    const dependencies = parse_references(
      block.dependencies,
      guest.artifact.guest_id,
      guest.artifact.artifact_digest,
      id,
      "dependency",
    );
    const capabilities = parse_references(
      block.capabilities,
      guest.artifact.guest_id,
      guest.artifact.artifact_digest,
      id,
      "capability",
    );
    blocks.set(
      id,
      Object.freeze({
        id,
        dependencies,
        capabilities,
        acquire: (context: BlockAcquireContext) => block.acquire(context),
      }),
    );
  }

  for (const block of blocks.values()) {
    for (const dependency of block.dependencies) {
      if (!blocks.has(dependency)) {
        throw new Error(
          `guest ${JSON.stringify(guest.artifact.guest_id)} artifact ${
            JSON.stringify(guest.artifact.artifact_digest)
          } block ${JSON.stringify(block.id)} depends on missing block ${
            JSON.stringify(dependency)
          }`,
        );
      }
    }
  }

  const ordered: Block[] = [];
  const visiting: string[] = [];
  const visited = new Set<string>();
  const visit = (block: Block): void => {
    if (visited.has(block.id)) return;
    const cycle_start = visiting.indexOf(block.id);
    if (cycle_start !== -1) {
      const cycle = [...visiting.slice(cycle_start), block.id];
      throw new Error(
        `guest ${JSON.stringify(guest.artifact.guest_id)} artifact ${
          JSON.stringify(guest.artifact.artifact_digest)
        } block dependency cycle ${cycle.join(" -> ")}`,
      );
    }
    visiting.push(block.id);
    for (const dependency of block.dependencies) visit(blocks.get(dependency)!);
    visiting.pop();
    visited.add(block.id);
    ordered.push(block);
  };
  for (const block of blocks.values()) visit(block);
  return Object.freeze({
    guest_id: guest.artifact.guest_id,
    blocks: Object.freeze(ordered),
  });
}

function parse_references(
  references: readonly string[],
  guest_id: string,
  artifact_digest: string,
  block_id: string,
  kind: string,
): readonly string[] {
  if (!Array.isArray(references)) {
    throw new Error(
      `guest ${JSON.stringify(guest_id)} artifact ${
        JSON.stringify(artifact_digest)
      } block ${JSON.stringify(block_id)} ${kind} references must be an array`,
    );
  }
  const parsed = references.map((reference, index) =>
    parse_identity(
      reference,
      `guest ${JSON.stringify(guest_id)} artifact ${
        JSON.stringify(artifact_digest)
      } block ${JSON.stringify(block_id)} ${kind} ${index}`,
    )
  );
  const unique = new Set(parsed);
  if (unique.size !== parsed.length) {
    throw new Error(
      `guest ${JSON.stringify(guest_id)} artifact ${
        JSON.stringify(artifact_digest)
      } block ${
        JSON.stringify(block_id)
      } declares duplicate ${kind} references ${JSON.stringify(parsed)}`,
    );
  }
  return Object.freeze(parsed);
}
