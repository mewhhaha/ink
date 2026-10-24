/** Compile an explicitly authored graph into checked Blot, retaining State/Advanced. */
import { dirname, resolve } from "node:path";
import { checked } from "./derive.ts";

type Node =
  & { id: number }
  & (
    | { kind: "act"; action: string; next: number }
    | { kind: "delay"; seconds: number; next: number }
    | { kind: "until"; condition: string; next: number }
    | { kind: "choose"; condition: string; yes: number; no: number }
    | { kind: "repeat"; count: number; body: number; next: number }
    | { kind: "again"; owner: number }
    | { kind: "stop" }
  );
export interface Graph {
  name: string;
  version: number;
  entry: number;
  local: string;
  action: string;
  condition: string;
  act: string;
  ready: string;
  cleanup: string;
  nodes: Node[];
}
const u32 = (n: number) => {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    throw new Error(`Invalid graph U32: ${n}`);
  }
};
const float = (n: number) => Number.isInteger(n) ? `${n}.0` : String(n);
function validate(g: Graph) {
  for (
    const key of [
      "name",
      "local",
      "action",
      "condition",
      "act",
      "ready",
      "cleanup",
    ] as const
  ) {
    if (
      typeof g[key] !== "string" ||
      !/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*$/.test(g[key])
    ) throw new Error(`Invalid graph ${key}`);
  }
  if (g.name.includes(".")) {
    throw new Error("Graph name must be a local identifier");
  }
  u32(g.version);
  u32(g.entry);
  if (!Array.isArray(g.nodes) || !g.nodes.length) {
    throw new Error("Graph needs nodes");
  }
  const nodes = new Map<number, Node>();
  for (const node of g.nodes) {
    u32(node.id);
    if (nodes.has(node.id)) throw new Error(`Duplicate graph node ${node.id}`);
    nodes.set(node.id, node);
  }
  const target = (id: number) => {
    u32(id);
    if (!nodes.has(id)) throw new Error(`Missing graph target ${id}`);
  };
  target(g.entry);
  for (const n of g.nodes) {
    switch (n.kind) {
      case "act":
        if (typeof n.action !== "string" || !n.action.trim()) {
          throw new Error("Missing action expression");
        }
        target(n.next);
        break;
      case "delay":
        if (
          !Number.isFinite(n.seconds) ||
          !Number.isFinite(Math.fround(n.seconds)) || n.seconds < 0
        ) throw new Error("Invalid delay");
        target(n.next);
        break;
      case "until":
      case "choose":
        if (typeof n.condition !== "string" || !n.condition.trim()) {
          throw new Error("Missing condition expression");
        }
        if (n.kind === "until") target(n.next);
        else {
          target(n.yes);
          target(n.no);
        }
        break;
      case "repeat":
        u32(n.count);
        target(n.body);
        target(n.next);
        break;
      case "again":
        target(n.owner);
        if (nodes.get(n.owner)?.kind !== "repeat") {
          throw new Error("Again owner must be Repeat");
        }
        break;
      case "stop":
        break;
      default:
        throw new Error("Unknown graph operation");
    }
  }
  return nodes;
}
export function compileGraph(g: Graph): string {
  const nodes = validate(g);
  const authored = g.nodes.map((n) => {
    const b = "_behavior";
    switch (n.kind) {
      case "act":
        return `${b}.action ${n.id} (${n.action}) ${n.next}`;
      case "delay":
        return `${b}.wait ${n.id} ${float(n.seconds)} ${n.next}`;
      case "until":
        return `${b}.until ${n.id} (${n.condition}) ${n.next}`;
      case "choose":
        return `${b}.branch ${n.id} (${n.condition}) ${n.yes} ${n.no}`;
      case "repeat":
        return `${b}.repeat ${n.id} ${n.count} ${n.body} ${n.next}`;
      case "again":
        return `${b}.again ${n.id} ${n.owner}`;
      case "stop":
        return `${b}.stop ${n.id}`;
    }
  });
  const move = (
    next: number | string,
  ) => [`step := ${next}`, "age := 0.0", "transitions := self + 1"];
  const arms = g.nodes.map((n) => {
    let body: string[];
    switch (n.kind) {
      case "act":
        body = [
          `let outcome = ${g.act} (${n.action}) (#_behavior.Tick { seconds: remaining, elapsed: age }) local_value`,
          "case outcome of",
          "  #_behavior.Done { local, remaining: left } => do:",
          "    if Bool.not (is_finite left) || left < 0.0 || left > remaining:",
          "      return #Nothing",
          "    local_value := local",
          "    remaining := left",
          ...move(n.next).map((s) => `    ${s}`),
          "  #_behavior.Waiting { local, reason } => do:",
          "    local_value := local",
          "    age := elapsed",
          "    remaining := 0.0",
          "    status := #_behavior.Action reason",
          "    waiting := #True",
          "  #_behavior.Abort { local, reason } => do:",
          `    local_value := ${g.cleanup} reason local`,
          "    frames := #[]",
          "    status := #_behavior.Interrupted reason",
        ];
        break;
      case "delay":
        body = [
          `remaining := max 0.0 (elapsed - ${float(n.seconds)})`,
          `if elapsed >= ${float(n.seconds)}:`,
          ...move(n.next).map((s) => `  ${s}`),
          "else:",
          "  age := elapsed",
          "  status := #_behavior.Time",
          "  waiting := #True",
        ];
        break;
      case "until":
        body = [
          `if ${g.ready} (${n.condition}) local_value:`,
          ...move(n.next).map((s) => `  ${s}`),
          "else:",
          "  age := elapsed",
          "  remaining := 0.0",
          "  status := #_behavior.Condition",
          "  waiting := #True",
        ];
        break;
      case "choose":
        body = move(
          `if ${g.ready} (${n.condition}) local_value then ${n.yes} else ${n.no}`,
        );
        break;
      case "repeat":
        body = n.count === 0 ? move(n.next) : [
          "if frames.length >= max_frames:",
          "  status := #_behavior.StackFull",
          "  waiting := #True",
          "else:",
          `  frames := @array.concat self #[{ owner: ${n.id}, remaining: ${n.count} }]`,
          ...move(n.body).map((s) => `  ${s}`),
        ];
        break;
      case "again": {
        const owner = nodes.get(n.owner)!;
        if (owner.kind !== "repeat") throw new Error("Unvalidated owner");
        body = [
          "if frames.length == 0:",
          "  return #Nothing",
          "let at = frames.length - 1",
          "let frame = frames[at]",
          `if frame.owner != ${n.owner}:`,
          "  return #Nothing",
          "if frame.remaining > 1:",
          "  frame.remaining := self - 1",
          "  frames[at] := frame",
          `  step := ${owner.body}`,
          "else:",
          "  frames := @array.slice self 0 at",
          `  step := ${owner.next}`,
          "age := 0.0",
          "transitions := self + 1",
        ];
        break;
      }
      case "stop":
        body = ["status := #_behavior.Finished", "frames := #[]"];
        break;
    }
    return [
      `      ${n.id} => do:`,
      `        visited := @array.concat self #[${n.id}]`,
      ...body.map((s) => `        ${s}`),
    ].join("\n");
  });
  return `const ${g.name}_program: _behavior.Program [${g.action}, ${g.condition}] = do:
  let #Some program = _behavior.build ${g.version} ${g.entry} #[${
    authored.join(", ")
  }] else:
    break @panic "invalid generated behavior program"
  break program
const ${g.name}_advance: _behavior.State ${g.local} -> F32 -> U32 -> U32 -> Maybe (_behavior.Advanced ${g.local}) = fn state => fn seconds => fn budget => fn max_frames => do:
  if state.version != ${g.version} || Bool.not (is_finite seconds) || seconds < 0.0:
    return #Nothing
  if state.frames.length > max_frames || Bool.not (is_finite state.elapsed) || state.elapsed < 0.0:
    return #Nothing
  let remaining = seconds
  let transitions = 0
  let visited: Array U32 = #[]
  if _behavior.terminal state.status:
    return #Some (#_behavior.Advanced { state, remaining, transitions, visited })
  let step = state.step
  let age = state.elapsed
  let local_value = state.local
  let frames = state.frames
  let status = #_behavior.Running
  let waiting = #False
  for used in 0 .. budget:
    if waiting || _behavior.terminal status:
      break
    let elapsed = age + remaining
    if Bool.not (is_finite elapsed):
      return #Nothing
    case step of
${arms.join("\n")}
      _ => do:
        return #Nothing
  if Bool.not waiting && Bool.not (_behavior.terminal status):
    status := #_behavior.Budget
  return #Some (#_behavior.Advanced { state: #_behavior.State { version: state.version, step, elapsed: age, local: local_value, frames, status }, remaining, transitions, visited })
`;
}

/** One-shot selection: only acyclic choices ending in one action then stop.
 * Selects an action without executing it, allocating progress or recording a
 * trace. Resumable/waiting programs must use compileGraph instead.
 */
export function compileSelector(g: Graph): string {
  const nodes = validate(g);
  if (nodes.size > 1024) throw new Error("Selector exceeds 1024 nodes");
  const reached = new Set<number>(), visiting = new Set<number>();
  const height = new Map<number, number>();
  const visit = (id: number, depth: number) => {
    if (visiting.has(id)) throw new Error("Selector contains a cycle");
    if (depth > 64) throw new Error("Selector exceeds 64 decisions");
    if (reached.has(id)) return;
    visiting.add(id);
    const node = nodes.get(id)!;
    if (node.kind === "choose") {
      visit(node.yes, depth + 1);
      visit(node.no, depth + 1);
      height.set(id, 1 + Math.max(height.get(node.yes)!, height.get(node.no)!));
    } else if (node.kind !== "act" || nodes.get(node.next)!.kind !== "stop") {
      throw new Error("Selector must choose one action followed by stop");
    } else height.set(id, 0);
    if (height.get(id)! > 64) throw new Error("Selector exceeds 64 decisions");
    visiting.delete(id);
    reached.add(id);
  };
  visit(g.entry, 0);
  const name = (id: number) => `${g.name}_select_node_${id}`;
  return [...reached].map((id) => {
    const node = nodes.get(id)!;
    const body = node.kind === "act"
      ? node.action
      : node.kind === "choose"
      ? `if ${g.ready} (${node.condition}) local then ${
        name(node.yes)
      } local else ${name(node.no)} local`
      : "";
    return `const ${
      name(id)
    } = fn (local: ${g.local}) -> ${g.action} => ${body}`;
  }).join("\n") + `\nconst ${g.name}_select = ${name(g.entry)}\n`;
}
export async function generateBehavior(
  options: {
    source: string;
    graph: string;
    output: string;
    check?: boolean;
    imports?: Record<string, URL>;
  },
) {
  const source = resolve(options.source), output = resolve(options.output);
  if (source === output || dirname(source) !== dirname(output)) {
    throw new Error(
      "Generated behavior must be beside, and distinct from, its source",
    );
  }
  const graph = JSON.parse(await Deno.readTextFile(options.graph)) as Graph;
  const generated = compileGraph(graph);
  const imports = options.imports ?? {};
  await checked(source, imports);
  const code =
    `// Generated checked behavior; graph IDs are saved-state identity.\nimport * as _behavior from "ink/behavior"\n${await Deno
      .readTextFile(source)}\n${generated}`;
  const temporary = await Deno.makeTempFile({
    dir: dirname(output),
    prefix: ".behavior-",
    suffix: ".blot",
  });
  try {
    await Deno.writeTextFile(temporary, code);
    await checked(temporary, imports);
    if (options.check) {
      if (await Deno.readTextFile(output) !== code) {
        throw new Error(`Stale generated behavior: ${output}`);
      }
    } else await Deno.rename(temporary, output);
  } finally {
    await Deno.remove(temporary).catch(() => {});
  }
}
if (import.meta.main) {
  const arg = (name: string) => {
    const at = Deno.args.indexOf(name);
    if (at < 0 || !Deno.args[at + 1]) throw new Error(`Missing ${name}`);
    return Deno.args[at + 1];
  };
  await generateBehavior({
    source: arg("--source"),
    graph: arg("--graph"),
    output: arg("--output"),
    check: Deno.args.includes("--check"),
  });
}
