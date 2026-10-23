import { assertEquals, assertThrows } from "@std/assert";
import { compile } from "./support.ts";
import {
  compileGraph,
  generateBehavior,
  type Graph,
} from "../tools/behavior-derive.ts";
const fixture = await compile(
  new URL("./compiled-behavior.blot", import.meta.url),
);
const graph = JSON.parse(
  await Deno.readTextFile(
    new URL("./fixtures/behavior/graph.json", import.meta.url),
  ),
) as Graph;
Deno.test("compiled graph preserves state, full traces, waits, stack limits, aborts and save boundaries", () => {
  const words = (values: number[]) =>
    new Uint32Array(new Float32Array(values).buffer);
  for (const budget of [0, 1, 2, 7, 64]) {
    for (const frames of [0, 1, 2, 4]) {
      for (const local of [0, 1, 100]) {
        for (const restore of [0, 1]) {
          for (
            const deltas of [[1], Array(32).fill(0.125), [0, 0.25, 0, 0.5, 1]]
          ) {
            const input = new Uint32Array([
              0,
              budget,
              frames,
              local,
              restore,
              10,
              ...words(deltas),
            ]);
            const reference = fixture.guest.call("replay", input);
            input[0] = 1;
            assertEquals(fixture.guest.call("replay", input), reference);
          }
        }
      }
    }
  }
  for (const step of [45, 60, 70, 95, 999]) {
    const input = new Uint32Array([0, 64, 4, 0, 0, step, ...words([1])]);
    const expected = fixture.guest.call("replay", input);
    input[0] = 1;
    assertEquals(fixture.guest.call("replay", input), expected);
  }
  for (const n of [0, 1, 64, 1024]) {
    assertEquals(
      fixture.guest.call("compiled", n),
      new Uint32Array([6 * n, 24 * n, 25 * n]),
    );
    assertEquals(
      fixture.guest.call("compiled", n),
      fixture.guest.call("interpreted", n),
    );
  }
});
Deno.test("behavior generation is checked and reproducible, rejecting broken authored graphs", async () => {
  await generateBehavior({
    source: "tests/fixtures/behavior/actions.blot",
    graph: "tests/fixtures/behavior/graph.json",
    output: "tests/fixtures/behavior/actions_derived.blot",
    check: true,
  });
  for (
    const change of [
      { entry: 999 },
      { version: -1 },
      { nodes: [...graph.nodes, graph.nodes[0]] },
      { nodes: [{ id: 10, kind: "again", owner: 10 }] },
      { nodes: [{ id: 10, kind: "delay", seconds: Infinity, next: 10 }] },
    ]
  ) {
    assertThrows(() => compileGraph({ ...graph, ...change } as Graph));
  }
});
Deno.test.afterAll(() => fixture.dispose());
