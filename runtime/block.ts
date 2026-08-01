import {
  Do,
  get,
  Program,
  put,
  run_state_terminal,
  type StateValue,
} from "@mewhhaha/typeclasses";

export type BlockRequirement = "required" | "degradable";

export interface EngineBlock {
  readonly id: string;
  readonly depends_on: readonly string[];
  readonly requirement: BlockRequirement;
}

interface BlockResolution {
  readonly ordered: readonly EngineBlock[];
  readonly visiting: readonly string[];
  readonly visited: ReadonlySet<string>;
}

export function resolve_block_order(
  blocks: readonly EngineBlock[],
): readonly EngineBlock[] {
  const by_id = new Map<string, EngineBlock>();
  for (const block of blocks) {
    if (by_id.has(block.id)) {
      throw new Error(
        `engine block id ${JSON.stringify(block.id)} is duplicated`,
      );
    }
    by_id.set(block.id, block);
  }
  const initial: BlockResolution = {
    ordered: [],
    visiting: [],
    visited: new Set(),
  };

  const program = Program(function* () {
    for (const block of blocks) {
      yield* visit_block(block, by_id);
    }
  });
  const [, resolution] = run_state_terminal(program, initial);
  return resolution.ordered;
}

function visit_block(
  block: EngineBlock,
  by_id: ReadonlyMap<string, EngineBlock>,
): StateValue<BlockResolution, void> {
  return Do(function* () {
    const before = yield* get<BlockResolution>();
    if (before.visited.has(block.id)) return;
    if (before.visiting.includes(block.id)) {
      throw new Error(
        `engine block cycle is ${[...before.visiting, block.id].join(" -> ")}`,
      );
    }

    yield* put<BlockResolution>({
      ...before,
      visiting: [...before.visiting, block.id],
    });
    for (const dependency_id of block.depends_on) {
      const dependency = by_id.get(dependency_id);
      if (!dependency) {
        throw new Error(
          `engine block ${block.id} requires missing block ${dependency_id}`,
        );
      }
      yield* visit_block(dependency, by_id);
    }

    const after_dependencies = yield* get<BlockResolution>();
    const visited = new Set(after_dependencies.visited);
    visited.add(block.id);
    yield* put<BlockResolution>({
      ordered: [...after_dependencies.ordered, block],
      visiting: after_dependencies.visiting.filter((id) => id !== block.id),
      visited,
    });
  });
}

export const core_blocks: readonly EngineBlock[] = [
  { id: "clock", depends_on: [], requirement: "required" },
  { id: "assets", depends_on: [], requirement: "degradable" },
  { id: "input", depends_on: ["clock"], requirement: "required" },
  { id: "game", depends_on: ["input"], requirement: "required" },
  { id: "semantic", depends_on: ["game"], requirement: "required" },
  {
    id: "render",
    depends_on: ["game", "assets"],
    requirement: "degradable",
  },
  {
    id: "observability",
    depends_on: ["game", "semantic"],
    requirement: "required",
  },
  { id: "save", depends_on: ["game"], requirement: "required" },
  {
    id: "replay",
    depends_on: ["save", "observability"],
    requirement: "required",
  },
];
