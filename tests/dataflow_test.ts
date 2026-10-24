import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { compileDataflow, type Dataflow } from "../tools/dataflow-derive.ts";
import { compile } from "./support.ts";
import { pathToFileURL } from "node:url";
const graph: Dataflow = {
  name: "prepared",
  input: { name: "snapshot", type: "U32" },
  result: "U32",
  steps: [
    { id: "joined", call: "sum", args: ["a", "b"] },
    { id: "a", call: "twice", args: ["snapshot"] },
    { id: "b", call: "next", args: ["snapshot"] },
  ],
  finish: { call: "identity", args: ["joined"] },
};
Deno.test("pure dataflow waves follow dependencies, independent of declaration order", async () => {
  const generated = compileDataflow(graph);
  assertEquals(generated.waves, [[1, 2], [0]]);
  const path = await Deno.makeTempFile({ dir: ".cache", suffix: ".blot" });
  try {
    await Deno.writeTextFile(
      path,
      `
const twice = fn (x: U32) => x * 2
const next = fn (x: U32) => x + 1
const sum = fn (a: U32) (b: U32) => a + b
${generated.source}
entry const run = prepared
`,
    );
    const fixture = await compile(pathToFileURL(await Deno.realPath(path)));
    try {
      for (let i = 0; i < 1024; i++) {
        assertEquals(fixture.guest.call("run", i), 3 * i + 1);
      }
    } finally {
      await fixture.dispose();
    }
  } finally {
    await Deno.remove(path);
  }
});
Deno.test("dataflow rejects cycles, unused work, invalid references and duplicated outputs", () => {
  assertThrows(() =>
    compileDataflow({ ...graph, steps: [...graph.steps, graph.steps[0]] })
  );
  assertThrows(() =>
    compileDataflow({
      ...graph,
      steps: [...graph.steps, {
        id: "extra",
        call: "twice",
        args: ["snapshot"],
      }],
    })
  );
  assertThrows(() =>
    compileDataflow({
      ...graph,
      finish: { call: "identity", args: ["unknown"] },
    })
  );
  assertThrows(() =>
    compileDataflow({
      ...graph,
      steps: [{ id: "loop", call: "next", args: ["loop"] }],
      finish: { call: "identity", args: ["loop"] },
    })
  );
  assertThrows(() =>
    compileDataflow({
      ...graph,
      finish: { call: "identity", args: ["(panic)"] },
    })
  );
});
Deno.test("generated pure dataflow rejects effectful operations even when its caller handles them", async () => {
  const path = await Deno.makeTempFile({ dir: ".cache", suffix: ".blot" });
  try {
    await Deno.writeTextFile(
      path,
      `
type Observed is effect = U32 -> U32
const twice = fn (x: U32) => Observed x
const next = fn (x: U32) => x + 1
const sum = fn (a: U32) (b: U32) => a + b
${compileDataflow(graph).source}
entry const run = fn (x: U32) => do (@effect.provider Observed (fn n => n)):
  return prepared x
`,
    );
    await assertRejects(
      () => compile(pathToFileURL(path)),
      Error,
      "let_effect",
    );
  } finally {
    await Deno.remove(path);
  }
});
