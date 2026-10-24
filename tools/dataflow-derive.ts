/** Compile a bounded pure dataflow graph to ordinary, type-checked Blot calls. */
export interface Dataflow {
  name: string;
  input: { name: string; type: string };
  result: string;
  steps: { id: string; call: string; args: string[] }[];
  finish: { call: string; args: string[] };
}
const qualified = /^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*$/;
const local = /^[A-Za-z_][\w]*$/;
const outputName = "_dataflow_result";
export function compileDataflow(g: Dataflow) {
  if (
    !local.test(g.name) || !local.test(g.input.name) ||
    g.input.name === outputName ||
    !qualified.test(g.input.type) || !qualified.test(g.result) ||
    !Array.isArray(g.steps) || g.steps.length > 256
  ) {
    throw new Error("Invalid dataflow declaration");
  }
  const positions = new Map<string, number>();
  for (const [i, step] of g.steps.entries()) {
    if (
      !local.test(step.id) || step.id === outputName ||
      step.id === g.input.name || positions.has(step.id)
    ) {
      throw new Error("Duplicate or invalid dataflow result");
    }
    positions.set(step.id, i);
  }
  const dependencies = (step: Dataflow["finish"]) => {
    if (
      !qualified.test(step.call) || !Array.isArray(step.args) ||
      step.args.length > 16
    ) {
      throw new Error("Invalid dataflow call");
    }
    const edges = new Set<number>();
    for (const arg of step.args) {
      if (!qualified.test(arg)) {
        throw new Error("Arguments must be result references");
      }
      const root = arg.split(".")[0];
      if (root === g.input.name) continue;
      const index = positions.get(root);
      if (index === undefined) {
        throw new Error(`Unknown dataflow value ${root}`);
      }
      edges.add(index);
    }
    return [...edges].sort((a, b) => a - b);
  };
  const edges = g.steps.map(dependencies);
  const output = dependencies(g.finish);
  const needed = new Set<number>();
  const pending = [...output];
  while (pending.length) {
    const index = pending.pop()!;
    if (needed.has(index)) continue;
    needed.add(index);
    pending.push(...edges[index]);
  }
  if (needed.size !== g.steps.length) throw new Error("Unused dataflow step");
  const done = new Set<number>();
  const waves: number[][] = [];
  while (done.size !== g.steps.length) {
    const wave = g.steps.flatMap((_, i) =>
      !done.has(i) && edges[i].every((j) => done.has(j)) ? [i] : []
    );
    if (!wave.length) throw new Error("Cyclic dataflow graph");
    waves.push(wave);
    for (const index of wave) done.add(index);
  }
  const call = (step: Dataflow["finish"]) =>
    `${step.call} ${step.args.length ? step.args.join(" ") : "()"}`;
  // The closed function type makes accidentally effectful nodes a compiler
  // error. Waves describe dependencies only; this emitter executes serially.
  const source = [
    `// Generated pure dataflow. Serial execution; waves are eligibility metadata.`,
    `const ${g.name}: ${g.input.type} -> ${g.result} = fn ${g.input.name} => do:`,
    ...waves.flat().map((i) => `  let ${g.steps[i].id} = ${call(g.steps[i])}`),
    `  let ${outputName} = ${call(g.finish)}`,
    `  return ${outputName}`,
    "",
  ].join("\n");
  return { source, dependencies: edges, waves };
}
