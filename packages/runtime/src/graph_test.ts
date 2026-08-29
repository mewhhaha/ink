import { assertEquals, assertThrows } from "@std/assert";
import { parse_game_artifact } from "./artifact.ts";
import type { Block, RuntimeGuestStructure } from "./graph.ts";
import { resolve_runtime_graph } from "./graph.ts";

const artifact = parse_game_artifact({
  guest_id: "graph-guest",
  artifact_digest: "artifact-1",
  schema_digest: "schema-1",
  wasm: new Uint8Array([1]),
  capabilities: [],
});

function block(id: string, dependencies: readonly string[]): Block {
  return { id, dependencies, capabilities: [], acquire: () => ({}) };
}

Deno.test("runtime graph orders dependencies before consumers deterministically", () => {
  const guest: RuntimeGuestStructure = {
    artifact,
    blocks: [
      block("presentation", ["simulation", "input"]),
      block("input", []),
      block("simulation", ["input"]),
      block("unrelated", []),
    ],
  };
  assertEquals(
    resolve_runtime_graph(guest).blocks.map(({ id }) => id),
    ["input", "simulation", "presentation", "unrelated"],
  );
});

Deno.test("runtime graph reports the complete dependency cycle", () => {
  assertThrows(
    () =>
      resolve_runtime_graph({
        artifact,
        blocks: [
          block("scene", ["physics"]),
          block("physics", ["animation"]),
          block("animation", ["scene"]),
        ],
      }),
    Error,
    "scene -> physics -> animation -> scene",
  );
});

Deno.test("runtime graph reports the block and missing dependency", () => {
  assertThrows(
    () =>
      resolve_runtime_graph({
        artifact,
        blocks: [block("scene", ["assets"])],
      }),
    Error,
    'block "scene" depends on missing block "assets"',
  );
});
