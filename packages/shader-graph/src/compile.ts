import { shader_module_id } from "@ink/shaders/identity.ts";
import type { WgslModule } from "@ink/shaders/model.ts";
import { create_wgsl_module } from "@ink/shaders/module.ts";
import { input_connections } from "./graph.ts";
import type {
  ShaderConstant,
  ShaderGraph,
  ShaderGraphNode,
  ShaderParameterSchema,
  ShaderValueType,
} from "./model.ts";

export interface CompiledShaderGraph {
  readonly module: WgslModule;
  readonly parameters: readonly ShaderParameterSchema[];
  readonly folded_nodes: readonly string[];
  readonly eliminated_nodes: readonly string[];
}

interface EmittedExpression {
  readonly source: string;
  readonly constant?: ShaderConstant;
}

export function compile_shader_graph(graph: ShaderGraph): CompiledShaderGraph {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const reachable = new Set<string>();
  const mark = (node: ShaderGraphNode): void => {
    if (reachable.has(node.id)) return;
    reachable.add(node.id);
    for (const connection of input_connections(node)) {
      mark(nodes.get(connection.node)!);
    }
  };
  for (const output of graph.outputs) mark(nodes.get(output.source.node)!);

  const reachable_parameters = graph.nodes.filter((node) =>
    node.kind === "parameter" && reachable.has(node.id)
  ).sort((left, right) =>
    left.kind === "parameter" && right.kind === "parameter"
      ? left.parameter.localeCompare(right.parameter)
      : 0
  );
  const parameter_names = new Map(
    reachable_parameters.flatMap((node) =>
      node.kind === "parameter"
        ? [
          [node.id, `parameter_${encoded_identifier(node.parameter)}`] as const,
        ]
        : []
    ),
  );
  const parameters = Object.freeze(
    reachable_parameters.flatMap((node) =>
      node.kind === "parameter"
        ? [Object.freeze({
          id: node.parameter,
          value_type: node.value_type,
          default_value: copy_constant(node.default_value),
        })]
        : []
    ),
  );
  const parameter_signature = reachable_parameters.flatMap((node) =>
    node.kind === "parameter"
      ? [`${parameter_names.get(node.id)}: ${wgsl_type(node.value_type)}`]
      : []
  ).join(", ");

  const folded = new Set<string>();
  const expressions = new Map<string, EmittedExpression>();
  const emit = (node: ShaderGraphNode): EmittedExpression => {
    const current = expressions.get(node.id);
    if (current !== undefined) return current;
    let emitted: EmittedExpression;
    if (node.kind === "constant") {
      emitted = {
        source: constant_source(node.value_type, node.value),
        constant: node.value,
      };
    } else if (node.kind === "parameter") {
      emitted = { source: parameter_names.get(node.id)! };
    } else if (node.kind === "binary") {
      const left = emit(nodes.get(node.left.node)!);
      const right = emit(nodes.get(node.right.node)!);
      const constant =
        left.constant === undefined || right.constant === undefined
          ? undefined
          : fold_binary(
            node.value_type,
            node.operation,
            left.constant,
            right.constant,
          );
      if (constant !== undefined) {
        folded.add(node.id);
        emitted = {
          source: constant_source(node.value_type, constant),
          constant,
        };
      } else {
        emitted = {
          source: `(${left.source} ${
            binary_operator(node.operation)
          } ${right.source})`,
        };
      }
    } else if (node.kind === "unary") {
      const source = emit(nodes.get(node.source.node)!);
      const constant = source.constant === undefined
        ? undefined
        : fold_unary(node.value_type, node.operation, source.constant);
      if (constant !== undefined) {
        folded.add(node.id);
        emitted = {
          source: constant_source(node.value_type, constant),
          constant,
        };
      } else {
        emitted = {
          source: node.operation === "negate"
            ? `(-${source.source})`
            : `clamp(${source.source}, ${typed_zero(node.value_type)}, ${
              typed_one(node.value_type)
            })`,
        };
      }
    } else {
      emitted = {
        source: `${node.function}(${
          node.arguments.map((argument) =>
            emit(nodes.get(argument.source.node)!).source
          ).join(", ")
        })`,
      };
    }
    expressions.set(node.id, emitted);
    return emitted;
  };

  const graph_name = encoded_identifier(graph.id);
  const functions = graph.outputs.map((output) => {
    const expression = emit(nodes.get(output.source.node)!);
    const name = `ink_graph_${graph_name}_${output.name}`;
    return {
      name,
      source: `fn ${name}(${parameter_signature}) -> ${
        wgsl_type(output.value_type)
      } {\n  return ${expression.source};\n}`,
    };
  });
  const dependency_symbols = new Map<string, Set<string>>();
  for (
    const node of graph.nodes.filter((node) =>
      node.kind === "call" && reachable.has(node.id)
    )
  ) {
    if (node.kind !== "call") continue;
    const symbols = dependency_symbols.get(node.module) ?? new Set<string>();
    symbols.add(node.function);
    dependency_symbols.set(node.module, symbols);
  }
  const dependencies = [...dependency_symbols].sort(([left], [right]) =>
    left.localeCompare(right)
  );
  const module = create_wgsl_module({
    id: shader_module_id(`graph/${graph.id}`),
    revision: graph.revision,
    dependencies: dependencies.map(([module, symbols]) => ({
      module: shader_module_id(module),
      symbols: [...symbols].sort(),
    })),
    symbols: functions.map(({ name }) => ({
      name,
      kind: "function",
      exported: true,
    })),
    source: functions.map(({ source }) => source).join("\n\n"),
  });
  return Object.freeze({
    module,
    parameters,
    folded_nodes: Object.freeze([...folded].sort()),
    eliminated_nodes: Object.freeze(
      graph.nodes.filter((node) => !reachable.has(node.id)).map(({ id }) => id)
        .sort(),
    ),
  });
}

function fold_binary(
  type: ShaderValueType,
  operation: "add" | "subtract" | "multiply" | "divide",
  left: ShaderConstant,
  right: ShaderConstant,
): ShaderConstant | undefined {
  if (typeof left === "boolean" || typeof right === "boolean") return undefined;
  const calculate = (first: number, second: number): number | undefined => {
    const uses_f32 = type === "f32" || type.startsWith("vec");
    const left_value = uses_f32 ? Math.fround(first) : first;
    const right_value = uses_f32 ? Math.fround(second) : second;
    if (operation === "divide" && right_value === 0) return undefined;
    const result = operation === "add"
      ? left_value + right_value
      : operation === "subtract"
      ? left_value - right_value
      : operation === "multiply"
      ? left_value * right_value
      : left_value / right_value;
    if (!Number.isFinite(result)) return undefined;
    if (type === "i32") {
      const integer = operation === "divide" ? Math.trunc(result) : result;
      return Number.isSafeInteger(integer) && integer >= -0x8000_0000 &&
          integer <= 0x7fff_ffff
        ? integer
        : undefined;
    }
    if (type === "u32") {
      const integer = operation === "divide" ? Math.trunc(result) : result;
      return Number.isSafeInteger(integer) && integer >= 0 &&
          integer <= 0xffff_ffff
        ? integer
        : undefined;
    }
    const rounded = Math.fround(result);
    return finite_f32(rounded) ? rounded : undefined;
  };
  if (typeof left === "number" && typeof right === "number") {
    return calculate(left, right);
  }
  if (
    !Array.isArray(left) || !Array.isArray(right) ||
    left.length !== right.length
  ) {
    return undefined;
  }
  const values = left.map((value, index) => calculate(value, right[index]));
  if (values.some((value) => value === undefined)) return undefined;
  return numeric_vector(
    values.filter((value): value is number => value !== undefined),
  );
}

function fold_unary(
  type: ShaderValueType,
  operation: "negate" | "saturate",
  value: ShaderConstant,
): ShaderConstant | undefined {
  if (typeof value === "boolean") return undefined;
  const calculate = (component: number): number | undefined => {
    const result = operation === "negate"
      ? -component
      : Math.max(0, Math.min(1, component));
    if (type === "i32" && (result < -0x8000_0000 || result > 0x7fff_ffff)) {
      return undefined;
    }
    const rounded = type === "f32" || type.startsWith("vec")
      ? Math.fround(result)
      : result;
    return finite_f32(rounded) ? rounded : undefined;
  };
  if (typeof value === "number") return calculate(value);
  const values = value.map(calculate);
  if (values.some((component) => component === undefined)) return undefined;
  return numeric_vector(
    values.filter((component): component is number => component !== undefined),
  );
}

function binary_operator(
  operation: "add" | "subtract" | "multiply" | "divide",
): string {
  return operation === "add"
    ? "+"
    : operation === "subtract"
    ? "-"
    : operation === "multiply"
    ? "*"
    : "/";
}

function constant_source(type: ShaderValueType, value: ShaderConstant): string {
  if (type === "bool") return String(value);
  if (type === "i32") return String(value);
  if (type === "u32") return `${String(value)}u`;
  if (type === "f32") return float_source(value as number);
  const values = value as readonly number[];
  return `${wgsl_type(type)}(${values.map(float_source).join(", ")})`;
}

function typed_zero(type: ShaderValueType): string {
  return type === "i32"
    ? "0"
    : type === "u32"
    ? "0u"
    : type === "f32"
    ? "0.0"
    : `${wgsl_type(type)}(0.0)`;
}

function typed_one(type: ShaderValueType): string {
  return type === "i32"
    ? "1"
    : type === "u32"
    ? "1u"
    : type === "f32"
    ? "1.0"
    : `${wgsl_type(type)}(1.0)`;
}

function float_source(value: number): string {
  if (Object.is(value, -0)) return "-0.0";
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

function wgsl_type(type: ShaderValueType): string {
  return type;
}

function encoded_identifier(value: string): string {
  return `id_${
    [...value].map((character) => `${character.codePointAt(0)!.toString(16)}_`)
      .join("")
  }`;
}

function copy_constant(value: ShaderConstant): ShaderConstant {
  return Array.isArray(value) ? numeric_vector(value) : value;
}

function numeric_vector(values: readonly number[]): ShaderConstant {
  if (values.length === 2) {
    const vector: [number, number] = [values[0], values[1]];
    return Object.freeze(vector);
  }
  if (values.length === 3) {
    const vector: [number, number, number] = [
      values[0],
      values[1],
      values[2],
    ];
    return Object.freeze(vector);
  }
  if (values.length === 4) {
    const vector: [number, number, number, number] = [
      values[0],
      values[1],
      values[2],
      values[3],
    ];
    return Object.freeze(vector);
  }
  throw new Error(
    `shader graph numeric vector has ${values.length} components; expected 2, 3, or 4`,
  );
}

function finite_f32(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= 3.402823466e38;
}
