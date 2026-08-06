import { shader_module_id } from "@ink/shaders/identity.ts";
import {
  shader_graph_id,
  shader_graph_node_id,
  shader_parameter_id,
} from "./identity.ts";
import { create_shader_graph } from "./graph.ts";
import type {
  ShaderConstant,
  ShaderGraph,
  ShaderGraphConnection,
  ShaderGraphNode,
  ShaderGraphOutput,
  ShaderValueType,
} from "./model.ts";

export function serialize_shader_graph(graph: ShaderGraph): string {
  return JSON.stringify({
    format: graph.format,
    version: graph.version,
    id: graph.id,
    revision: graph.revision,
    nodes: graph.nodes.map(serialized_node),
    outputs: graph.outputs.map((output) => ({
      name: output.name,
      value_type: output.value_type,
      source: serialized_connection(output.source),
    })),
  });
}

function serialized_node(node: ShaderGraphNode): object {
  const base = {
    id: node.id,
    kind: node.kind,
    value_type: node.value_type,
  };
  if (node.kind === "constant") return { ...base, value: node.value };
  if (node.kind === "parameter") {
    return {
      ...base,
      parameter: node.parameter,
      default_value: node.default_value,
    };
  }
  if (node.kind === "binary") {
    return {
      ...base,
      operation: node.operation,
      left: serialized_connection(node.left),
      right: serialized_connection(node.right),
    };
  }
  if (node.kind === "unary") {
    return {
      ...base,
      operation: node.operation,
      source: serialized_connection(node.source),
    };
  }
  return {
    ...base,
    module: node.module,
    function: node.function,
    arguments: node.arguments.map((argument) => ({
      name: argument.name,
      value_type: argument.value_type,
      source: serialized_connection(argument.source),
    })),
  };
}

function serialized_connection(connection: ShaderGraphConnection): object {
  return { node: connection.node, socket: connection.socket };
}

export function parse_shader_graph(source: string): ShaderGraph {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `shader graph JSON could not be parsed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  if (!record(value)) {
    throw new Error("shader graph JSON root must be an object");
  }
  if (value.format !== "ink-shader-graph" || value.version !== 1) {
    throw new Error(
      `shader graph format ${JSON.stringify(value.format)} version ${
        JSON.stringify(value.version)
      } is unsupported`,
    );
  }
  if (typeof value.id !== "string") {
    throw new Error("shader graph id must be a string");
  }
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
    throw new Error(
      `shader graph ${JSON.stringify(value.id)} revision ${
        JSON.stringify(value.revision)
      } must be nonnegative`,
    );
  }
  if (!Array.isArray(value.nodes) || !Array.isArray(value.outputs)) {
    throw new Error(
      `shader graph ${
        JSON.stringify(value.id)
      } nodes and outputs must be arrays`,
    );
  }
  return create_shader_graph({
    format: "ink-shader-graph",
    version: 1,
    id: shader_graph_id(value.id),
    revision: value.revision as number,
    nodes: value.nodes.map((node, index) => parse_node(node, index)),
    outputs: value.outputs.map((output, index) => parse_output(output, index)),
  });
}

function parse_node(value: unknown, index: number): ShaderGraphNode {
  if (!record(value)) {
    throw new Error(`shader graph node ${index} must be an object`);
  }
  if (typeof value.id !== "string" || typeof value.kind !== "string") {
    throw new Error(`shader graph node ${index} needs string id and kind`);
  }
  const id = shader_graph_node_id(value.id);
  const value_type = parse_value_type(value.value_type, `node ${id}`);
  if (value.kind === "constant") {
    return {
      id,
      kind: "constant",
      value_type,
      value: parse_constant(value.value, value_type, `node ${id}`),
    };
  }
  if (value.kind === "parameter") {
    if (typeof value.parameter !== "string") {
      throw new Error(
        `shader graph parameter node ${id} needs parameter identity`,
      );
    }
    return {
      id,
      kind: "parameter",
      value_type,
      parameter: shader_parameter_id(value.parameter),
      default_value: parse_constant(
        value.default_value,
        value_type,
        `parameter node ${id}`,
      ),
    };
  }
  if (value.kind === "binary") {
    if (
      !["add", "subtract", "multiply", "divide"].includes(
        String(value.operation),
      )
    ) {
      throw new Error(
        `shader graph binary node ${id} operation ${
          JSON.stringify(value.operation)
        } is unsupported`,
      );
    }
    return {
      id,
      kind: "binary",
      value_type,
      operation: value.operation as "add",
      left: parse_connection(value.left, `${id}.left`),
      right: parse_connection(value.right, `${id}.right`),
    };
  }
  if (value.kind === "unary") {
    if (!["negate", "saturate"].includes(String(value.operation))) {
      throw new Error(
        `shader graph unary node ${id} operation ${
          JSON.stringify(value.operation)
        } is unsupported`,
      );
    }
    return {
      id,
      kind: "unary",
      value_type,
      operation: value.operation as "negate",
      source: parse_connection(value.source, `${id}.source`),
    };
  }
  if (value.kind === "call") {
    if (
      typeof value.module !== "string" || typeof value.function !== "string" ||
      !Array.isArray(value.arguments)
    ) {
      throw new Error(
        `shader graph call node ${id} needs module, function, and arguments`,
      );
    }
    return {
      id,
      kind: "call",
      value_type,
      module: shader_module_id(value.module),
      function: value.function,
      arguments: value.arguments.map((argument, argument_index) => {
        if (!record(argument) || typeof argument.name !== "string") {
          throw new Error(
            `shader graph call node ${id} argument ${argument_index} is malformed`,
          );
        }
        return {
          name: argument.name,
          value_type: parse_value_type(
            argument.value_type,
            `call ${id} argument ${argument.name}`,
          ),
          source: parse_connection(
            argument.source,
            `${id}.${argument.name}`,
          ),
        };
      }),
    };
  }
  throw new Error(
    `shader graph node ${id} kind ${JSON.stringify(value.kind)} is unsupported`,
  );
}

function parse_output(value: unknown, index: number): ShaderGraphOutput {
  if (!record(value) || typeof value.name !== "string") {
    throw new Error(`shader graph output ${index} needs a string name`);
  }
  return {
    name: value.name,
    value_type: parse_value_type(value.value_type, `output ${value.name}`),
    source: parse_connection(value.source, `output ${value.name}`),
  };
}

function parse_connection(
  value: unknown,
  label: string,
): ShaderGraphConnection {
  if (
    !record(value) || typeof value.node !== "string" || value.socket !== "value"
  ) {
    throw new Error(
      `shader graph connection ${label} must reference a node value socket`,
    );
  }
  return { node: shader_graph_node_id(value.node), socket: "value" };
}

function parse_value_type(value: unknown, label: string): ShaderValueType {
  const types: readonly ShaderValueType[] = [
    "bool",
    "i32",
    "u32",
    "f32",
    "vec2f",
    "vec3f",
    "vec4f",
  ];
  if (!types.includes(value as ShaderValueType)) {
    throw new Error(
      `shader graph ${label} value type ${
        JSON.stringify(value)
      } is unsupported`,
    );
  }
  return value as ShaderValueType;
}

function parse_constant(
  value: unknown,
  type: ShaderValueType,
  label: string,
): ShaderConstant {
  if (type === "bool") {
    if (typeof value === "boolean") return value;
    throw new Error(
      `shader graph ${label} constant ${
        JSON.stringify(value)
      } does not match bool`,
    );
  }
  if (type === "vec2f" || type === "vec3f" || type === "vec4f") {
    const length = type === "vec2f" ? 2 : type === "vec3f" ? 3 : 4;
    if (
      !Array.isArray(value) || value.length !== length ||
      !value.every((component) =>
        typeof component === "number" && Number.isFinite(component)
      )
    ) {
      throw new Error(
        `shader graph ${label} constant ${
          JSON.stringify(value)
        } does not match ${type}`,
      );
    }
    if (length === 2) return [value[0], value[1]];
    if (length === 3) return [value[0], value[1], value[2]];
    return [value[0], value[1], value[2], value[3]];
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `shader graph ${label} constant ${
        JSON.stringify(value)
      } does not match ${type}`,
    );
  }
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
