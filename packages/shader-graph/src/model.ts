import type { ShaderModuleId } from "@ink/shaders/identity.ts";
import type {
  ShaderGraphId,
  ShaderGraphNodeId,
  ShaderParameterId,
} from "./identity.ts";

export type ShaderValueType =
  | "bool"
  | "i32"
  | "u32"
  | "f32"
  | "vec2f"
  | "vec3f"
  | "vec4f";

export type ShaderConstant =
  | boolean
  | number
  | readonly [number, number]
  | readonly [number, number, number]
  | readonly [number, number, number, number];

export interface ShaderGraphConnection {
  readonly node: ShaderGraphNodeId;
  readonly socket: "value";
}

interface GraphNodeBase {
  readonly id: ShaderGraphNodeId;
  readonly value_type: ShaderValueType;
}

export interface ConstantNode extends GraphNodeBase {
  readonly kind: "constant";
  readonly value: ShaderConstant;
}

export interface ParameterNode extends GraphNodeBase {
  readonly kind: "parameter";
  readonly parameter: ShaderParameterId;
  readonly default_value: ShaderConstant;
}

export interface BinaryNode extends GraphNodeBase {
  readonly kind: "binary";
  readonly operation: "add" | "subtract" | "multiply" | "divide";
  readonly left: ShaderGraphConnection;
  readonly right: ShaderGraphConnection;
}

export interface UnaryNode extends GraphNodeBase {
  readonly kind: "unary";
  readonly operation: "negate" | "saturate";
  readonly source: ShaderGraphConnection;
}

export interface CallArgument {
  readonly name: string;
  readonly value_type: ShaderValueType;
  readonly source: ShaderGraphConnection;
}

export interface CallNode extends GraphNodeBase {
  readonly kind: "call";
  readonly module: ShaderModuleId;
  readonly function: string;
  readonly arguments: readonly CallArgument[];
}

export type ShaderGraphNode =
  | ConstantNode
  | ParameterNode
  | BinaryNode
  | UnaryNode
  | CallNode;

export interface ShaderGraphOutput {
  readonly name: string;
  readonly value_type: ShaderValueType;
  readonly source: ShaderGraphConnection;
}

export interface ShaderGraphInput {
  readonly format: "ink-shader-graph";
  readonly version: 1;
  readonly id: ShaderGraphId;
  readonly revision: number;
  readonly nodes: readonly ShaderGraphNode[];
  readonly outputs: readonly ShaderGraphOutput[];
}

declare const shader_graph_brand: unique symbol;
export type ShaderGraph = ShaderGraphInput & {
  readonly [shader_graph_brand]: true;
};

export interface ShaderGraphSocket {
  readonly name: string;
  readonly direction: "input" | "output";
  readonly value_type: ShaderValueType;
}

export interface ShaderParameterSchema {
  readonly id: ShaderParameterId;
  readonly value_type: ShaderValueType;
  readonly default_value: ShaderConstant;
}
