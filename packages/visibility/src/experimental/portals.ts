import type { CellId } from "@ink/world/identity.ts";
import type { WorldPartition } from "@ink/world/experimental/partition.ts";

export type PortalTraversalResult =
  | {
    readonly type: "complete";
    readonly cells: ReadonlySet<CellId>;
    readonly traversed_portals: number;
  }
  | { readonly type: "fallback"; readonly reason: string };

export function traverse_visible_cells(
  partition: WorldPartition,
  starting_cells: readonly CellId[],
  maximum_depth: number,
): PortalTraversalResult {
  if (!Number.isSafeInteger(maximum_depth) || maximum_depth < 0) {
    throw new Error(
      `portal maximum depth ${
        JSON.stringify(maximum_depth)
      } must be nonnegative`,
    );
  }
  if (starting_cells.length === 0) {
    return {
      type: "fallback",
      reason: "camera is not inside a known world cell",
    };
  }
  const visited = new Set<CellId>();
  const pending = [...new Set(starting_cells)].sort().map((id) => ({
    id,
    depth: 0,
  }));
  let traversed_portals = 0;
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (visited.has(current.id)) continue;
    const cell = partition.cell(current.id);
    if (cell === undefined) {
      return {
        type: "fallback",
        reason: `portal traversal references missing cell ${
          JSON.stringify(current.id)
        }`,
      };
    }
    visited.add(current.id);
    const connected = partition.connected(current.id);
    if (
      current.depth === maximum_depth &&
      connected.some((id) => !visited.has(id))
    ) {
      return {
        type: "fallback",
        reason: `portal traversal from ${
          JSON.stringify(starting_cells)
        } exceeds depth ${maximum_depth}`,
      };
    }
    for (const destination of connected) {
      traversed_portals += 1;
      if (!visited.has(destination)) {
        pending.push({ id: destination, depth: current.depth + 1 });
      }
    }
    pending.sort((left, right) =>
      left.depth - right.depth || left.id.localeCompare(right.id)
    );
  }
  return { type: "complete", cells: visited, traversed_portals };
}
