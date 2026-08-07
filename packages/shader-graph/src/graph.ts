import { shader_identifier, shader_module_id } from "@ink/shaders/identity.ts";
import {
  shader_graph_id,
  shader_graph_node_id,
  shader_parameter_id,
} from "./identity.ts";
import type {
  ShaderConstant,
  ShaderGraph,
  ShaderGraphConnection,
  ShaderGraphInput,
  ShaderGraphNode,
  ShaderGraphSocket,
  ShaderValueType,
} from "./model.ts";

export function create_shader_graph(input: ShaderGraphInput): ShaderGraph {
  const id = shader_graph_id(input.id);
  if (input.format !== "ink-shader-graph" || input.version !== 1) {
    throw new Error(
      `shader graph ${input.id} format ${input.format} version ${input.version} is unsupported`,
    );
  }
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
    throw new Error(
      `shader graph ${input.id} revision ${
        JSON.stringify(input.revision)
      } must be nonnegative`,
    );
  }
  if (!Array.isArray(input.nodes) || !Array.isArray(input.outputs)) {
    throw new Error(`shader graph ${id} nodes and outputs must be arrays`);
  }
  const nodes = input.nodes.map((node) => canonical_node(id, node)).sort((
    left,
    right,
  ) => left.id.localeCompare(right.id));
  const nodes_by_id = new Map<string, ShaderGraphNode>();
  const parameters = new Map<string, ShaderGraphNode>();
  for (const node of nodes) {
    shader_graph_node_id(node.id);
    validate_value_type(
      node.value_type,
      `shader graph ${input.id} node ${node.id}`,
    );
    if (nodes_by_id.has(node.id)) {
      throw new Error(`shader graph ${input.id} repeats node ${node.id}`);
    }
    validate_node(input.id, node);
    nodes_by_id.set(node.id, node);
    if (node.kind === "parameter") {
      shader_parameter_id(node.parameter);
      const current = parameters.get(node.parameter);
      if (current !== undefined) {
        throw new Error(
          `shader graph ${input.id} nodes ${current.id} and ${node.id} repeat parameter ${node.parameter}`,
        );
      }
      parameters.set(node.parameter, node);
    }
  }
  for (const node of nodes) {
    for (const connection of input_connections(node)) {
      validate_connection(input.id, node.id, connection, nodes_by_id);
    }
    validate_input_types(input.id, node, nodes_by_id);
  }
  assert_acyclic(input.id, nodes, nodes_by_id);
  const outputs = input.outputs.map((output) => ({
    ...output,
    name: shader_identifier(output.name, `shader graph ${id} output`),
    source: canonical_connection(output.source),
  })).sort((left, right) => left.name.localeCompare(right.name));
  if (outputs.length === 0) {
    throw new Error(`shader graph ${input.id} needs at least one output`);
  }
  const output_names = new Set<string>();
  for (const output of outputs) {
    const name = shader_identifier(
      output.name,
      `shader graph ${input.id} output`,
    );
    if (output_names.has(name)) {
      throw new Error(`shader graph ${input.id} repeats output ${name}`);
    }
    output_names.add(name);
    validate_value_type(
      output.value_type,
      `shader graph ${input.id} output ${name}`,
    );
    validate_connection(input.id, `output ${name}`, output.source, nodes_by_id);
    const source = nodes_by_id.get(output.source.node)!;
    if (source.value_type !== output.value_type) {
      throw new Error(
        `shader graph ${input.id} output ${name} expects ${output.value_type} but node ${source.id} provides ${source.value_type}`,
      );
    }
  }
  return Object.freeze({
    format: "ink-shader-graph",
    version: 1,
    id,
    revision: input.revision,
    nodes: Object.freeze(nodes.map(freeze_node)),
    outputs: Object.freeze(outputs.map((output) =>
      Object.freeze({
        ...output,
        source: Object.freeze({ ...output.source }),
      })
    )),
  }) as ShaderGraph;
}

function canonical_node(graph: string, node: ShaderGraphNode): ShaderGraphNode {
  const id = shader_graph_node_id(node.id);
  const kind = node.kind as string;
  if (!["constant", "parameter", "binary", "unary", "call"].includes(kind)) {
    throw new Error(
      `shader graph ${graph} node ${id} kind ${
        JSON.stringify(kind)
      } is unsupported`,
    );
  }
  if (node.kind === "constant") return { ...node, id };
  if (node.kind === "parameter") {
    return { ...node, id, parameter: shader_parameter_id(node.parameter) };
  }
  if (node.kind === "binary") {
    if (!["add", "subtract", "multiply", "divide"].includes(node.operation)) {
      throw new Error(
        `shader graph ${graph} binary node ${id} operation ${
          JSON.stringify(node.operation)
        } is unsupported`,
      );
    }
    return {
      ...node,
      id,
      left: canonical_connection(node.left),
      right: canonical_connection(node.right),
    };
  }
  if (node.kind === "unary") {
    if (!["negate", "saturate"].includes(node.operation)) {
      throw new Error(
        `shader graph ${graph} unary node ${id} operation ${
          JSON.stringify(node.operation)
        } is unsupported`,
      );
    }
    return { ...node, id, source: canonical_connection(node.source) };
  }
  return {
    ...node,
    id,
    module: shader_module_id(node.module),
    function: shader_identifier(
      node.function,
      `shader graph ${graph} call ${id} function`,
    ),
    arguments: node.arguments.map((argument) => ({
      ...argument,
      name: shader_identifier(
        argument.name,
        `shader graph ${graph} call ${id} argument`,
      ),
      source: canonical_connection(argument.source),
    })),
  };
}

function canonical_connection(
  connection: ShaderGraphConnection,
): ShaderGraphConnection {
  return {
    node: shader_graph_node_id(connection.node),
    socket: connection.socket,
  };
}

export function shader_graph_sockets(
  node: ShaderGraphNode,
): readonly ShaderGraphSocket[] {
  const inputs = node.kind === "binary"
    ? [
      {
        name: "left",
        direction: "input" as const,
        value_type: node.value_type,
      },
      {
        name: "right",
        direction: "input" as const,
        value_type: node.value_type,
      },
    ]
    : node.kind === "unary"
    ? [{
      name: "source",
      direction: "input" as const,
      value_type: node.value_type,
    }]
    : node.kind === "call"
    ? node.arguments.map((argument) => ({
      name: argument.name,
      direction: "input" as const,
      value_type: argument.value_type,
    }))
    : [];
  return Object.freeze([
    ...inputs,
    {
      name: "value",
      direction: "output",
      value_type: node.value_type,
    } as const,
  ]);
}

function validate_node(graph: string, node: ShaderGraphNode): void {
  if (node.kind === "constant") {
    validate_constant(graph, node.id, node.value_type, node.value);
    return;
  }
  if (node.kind === "parameter") {
    validate_constant(graph, node.id, node.value_type, node.default_value);
    return;
  }
  if (node.kind === "binary") {
    if (node.value_type === "bool") {
      throw new Error(
        `shader graph ${graph} binary node ${node.id} cannot operate on bool`,
      );
    }
    return;
  }
  if (node.kind === "unary") {
    if (
      node.value_type === "bool" ||
      (node.operation === "negate" && node.value_type === "u32") ||
      (node.operation === "saturate" &&
        (node.value_type === "i32" || node.value_type === "u32"))
    ) {
      throw new Error(
        `shader graph ${graph} unary ${node.operation} node ${node.id} cannot operate on ${node.value_type}`,
      );
    }
    return;
  }
  shader_identifier(
    node.function,
    `shader graph ${graph} call ${node.id} function`,
  );
  const names = new Set<string>();
  for (const argument of node.arguments) {
    const name = shader_identifier(
      argument.name,
      `shader graph ${graph} call ${node.id} argument`,
    );
    if (names.has(name)) {
      throw new Error(
        `shader graph ${graph} call ${node.id} repeats argument ${name}`,
      );
    }
    names.add(name);
    validate_value_type(
      argument.value_type,
      `shader graph ${graph} call ${node.id} argument ${name}`,
    );
  }
}

function validate_input_types(
  graph: string,
  node: ShaderGraphNode,
  nodes: ReadonlyMap<string, ShaderGraphNode>,
): void {
  if (node.kind === "binary") {
    for (
      const [socket, connection] of [["left", node.left], [
        "right",
        node.right,
      ]] as const
    ) {
      const source = nodes.get(connection.node)!;
      if (source.value_type !== node.value_type) {
        throw new Error(
          `shader graph ${graph} node ${node.id} socket ${socket} expects ${node.value_type} but node ${source.id} provides ${source.value_type}`,
        );
      }
    }
  } else if (node.kind === "unary") {
    const source = nodes.get(node.source.node)!;
    if (source.value_type !== node.value_type) {
      throw new Error(
        `shader graph ${graph} node ${node.id} socket source expects ${node.value_type} but node ${source.id} provides ${source.value_type}`,
      );
    }
  } else if (node.kind === "call") {
    for (const argument of node.arguments) {
      const source = nodes.get(argument.source.node)!;
      if (source.value_type !== argument.value_type) {
        throw new Error(
          `shader graph ${graph} call ${node.id} argument ${argument.name} expects ${argument.value_type} but node ${source.id} provides ${source.value_type}`,
        );
      }
    }
  }
}

function validate_connection(
  graph: string,
  owner: string,
  connection: ShaderGraphConnection,
  nodes: ReadonlyMap<string, ShaderGraphNode>,
): void {
  if (connection.socket !== "value") {
    throw new Error(
      `shader graph ${graph} ${owner} references unsupported socket ${connection.socket}`,
    );
  }
  if (!nodes.has(connection.node)) {
    throw new Error(
      `shader graph ${graph} ${owner} references missing node ${connection.node}`,
    );
  }
}

function assert_acyclic(
  graph: string,
  nodes: readonly ShaderGraphNode[],
  nodes_by_id: ReadonlyMap<string, ShaderGraphNode>,
): void {
  const visited = new Set<string>();
  const visiting: string[] = [];
  const visit = (node: ShaderGraphNode): void => {
    if (visited.has(node.id)) return;
    const cycle_index = visiting.indexOf(node.id);
    if (cycle_index >= 0) {
      throw new Error(
        `shader graph ${graph} cycle ${
          [...visiting.slice(cycle_index), node.id].join(" -> ")
        }`,
      );
    }
    visiting.push(node.id);
    for (const connection of input_connections(node)) {
      visit(nodes_by_id.get(connection.node)!);
    }
    visiting.pop();
    visited.add(node.id);
  };
  for (const node of nodes) visit(node);
}

export function input_connections(
  node: ShaderGraphNode,
): readonly ShaderGraphConnection[] {
  if (node.kind === "binary") return [node.left, node.right];
  if (node.kind === "unary") return [node.source];
  if (node.kind === "call") return node.arguments.map(({ source }) => source);
  return [];
}

function validate_constant(
  graph: string,
  node: string,
  type: ShaderValueType,
  value: ShaderConstant,
): void {
  if (type === "bool") {
    if (typeof value !== "boolean") constant_failure(graph, node, type, value);
    return;
  }
  const length = type === "vec2f"
    ? 2
    : type === "vec3f"
    ? 3
    : type === "vec4f"
    ? 4
    : 0;
  if (length > 0) {
    if (
      !Array.isArray(value) || value.length !== length ||
      !value.every((component) =>
        typeof component === "number" && finite_f32(component) &&
        !Object.is(component, -0)
      )
    ) {
      constant_failure(graph, node, type, value);
    }
    return;
  }
  if (
    typeof value !== "number" || !Number.isFinite(value) ||
    Object.is(value, -0)
  ) {
    constant_failure(graph, node, type, value);
  }
  if ((type === "i32" || type === "u32") && !Number.isSafeInteger(value)) {
    constant_failure(graph, node, type, value);
  }
  if (
    (type === "i32" && (value < -0x8000_0000 || value > 0x7fff_ffff)) ||
    (type === "u32" && (value < 0 || value > 0xffff_ffff)) ||
    (type === "f32" && !finite_f32(value))
  ) {
    constant_failure(graph, node, type, value);
  }
}

function constant_failure(
  graph: string,
  node: string,
  type: ShaderValueType,
  value: ShaderConstant,
): never {
  throw new Error(
    `shader graph ${graph} node ${node} constant ${
      JSON.stringify(value)
    } does not match ${type}`,
  );
}

function validate_value_type(
  value: string,
  label: string,
): asserts value is ShaderValueType {
  if (
    !["bool", "i32", "u32", "f32", "vec2f", "vec3f", "vec4f"].includes(value)
  ) {
    throw new Error(
      `${label} value type ${JSON.stringify(value)} is unsupported`,
    );
  }
}

function freeze_node(node: ShaderGraphNode): ShaderGraphNode {
  if (node.kind === "constant") {
    return Object.freeze({ ...node, value: freeze_constant(node.value) });
  }
  if (node.kind === "parameter") {
    return Object.freeze({
      ...node,
      default_value: freeze_constant(node.default_value),
    });
  }
  if (node.kind === "binary") {
    return Object.freeze({
      ...node,
      left: Object.freeze({ ...node.left }),
      right: Object.freeze({ ...node.right }),
    });
  }
  if (node.kind === "unary") {
    return Object.freeze({
      ...node,
      source: Object.freeze({ ...node.source }),
    });
  }
  if (node.kind === "call") {
    return Object.freeze({
      ...node,
      arguments: Object.freeze(node.arguments.map((argument) =>
        Object.freeze({
          ...argument,
          source: Object.freeze({ ...argument.source }),
        })
      )),
    });
  }
  return node;
}

function freeze_constant(value: ShaderConstant): ShaderConstant {
  if (!Array.isArray(value)) return value;
  if (value.length === 2) {
    const vector: [number, number] = [value[0], value[1]];
    return Object.freeze(vector);
  }
  if (value.length === 3) {
    const vector: [number, number, number] = [
      value[0],
      value[1],
      value[2],
    ];
    return Object.freeze(vector);
  }
  const vector: [number, number, number, number] = [
    value[0],
    value[1],
    value[2],
    value[3],
  ];
  return Object.freeze(vector);
}

function finite_f32(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= 3.402823466e38;
}
