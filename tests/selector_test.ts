import { assertEquals, assertThrows } from "@std/assert";
import { compile } from "./support.ts";
import {
  compileGraph,
  compileSelector,
  type Graph,
} from "../tools/behavior-derive.ts";
import { pathToFileURL } from "node:url";

const graph: Graph = {
  name: "decision",
  version: 1,
  entry: 0,
  local: "U32",
  action: "U32",
  condition: "U32",
  act: "act",
  ready: "ready",
  cleanup: "cleanup",
  nodes: [
    { id: 0, kind: "choose", condition: "0", yes: 1, no: 2 },
    { id: 1, kind: "choose", condition: "0", yes: 3, no: 99 },
    { id: 2, kind: "choose", condition: "1", yes: 4, no: 5 },
    { id: 99, kind: "choose", condition: "99", yes: 3, no: 4 },
    { id: 3, kind: "act", action: "7", next: 10 },
    { id: 4, kind: "act", action: "11", next: 10 },
    { id: 5, kind: "act", action: "13", next: 10 },
    { id: 10, kind: "stop" },
  ],
};
Deno.test("generated selectors preserve branch laziness and agree with resumable graphs", async () => {
  const path = await Deno.makeTempFile({ dir: ".cache", suffix: ".blot" });
  try {
    await Deno.writeTextFile(
      path,
      `
import * as _behavior from "ink/behavior"
const ready = fn (condition: U32) (local: U32) =>
  if condition == 99 then @panic "unreachable condition was evaluated" else (local >> condition) & 1 != 0
const act = fn (action: U32) (tick: _behavior.Tick) (_: U32) => #_behavior.Done { local: action, remaining: tick.seconds }
const cleanup = fn (_: U32) (local: U32) => local
${compileGraph(graph)}
${compileSelector(graph)}
entry const selected = decision_select
entry const resumable = fn (local: U32) => do:
  let #Some result = decision_advance (_behavior.start decision_program local) 0.0 16 0 else:
    return @panic "graph failed"
  return result.state.local
`,
    );
    const fixture = await compile(pathToFileURL(await Deno.realPath(path)));
    try {
      for (let input = 0; input < 1024; input++) {
        const expected = input & 1 ? 7 : input & 2 ? 11 : 13;
        assertEquals(fixture.guest.call("selected", input), expected);
        assertEquals(fixture.guest.call("resumable", input), expected);
      }
    } finally {
      await fixture.dispose();
    }
  } finally {
    await Deno.remove(path);
  }
});
Deno.test("selectors reject waits, cycles, missing actions and multiple actions", () => {
  for (
    const nodes of [
      [{ id: 0, kind: "stop" }],
      [{ id: 0, kind: "choose", condition: "0", yes: 0, no: 0 }],
      [{ id: 0, kind: "delay", seconds: 0.1, next: 0 }],
      [{ id: 0, kind: "act", action: "7", next: 0 }],
    ]
  ) {
    assertThrows(() => compileSelector({ ...graph, nodes } as Graph));
  }
  const deep = Array.from({ length: 65 }, (_, id) => ({
    id,
    kind: "choose",
    condition: "0",
    yes: id + 1,
    no: 65,
  }));
  assertThrows(() =>
    compileSelector({
      ...graph,
      nodes: [
        ...deep,
        { id: 65, kind: "act", action: "7", next: 66 },
        { id: 66, kind: "stop" },
      ],
    } as Graph)
  );
});
