declare const shader_graph_id_brand: unique symbol;
declare const shader_graph_node_id_brand: unique symbol;
declare const shader_parameter_id_brand: unique symbol;

export type ShaderGraphId = string & { readonly [shader_graph_id_brand]: true };
export type ShaderGraphNodeId = string & {
  readonly [shader_graph_node_id_brand]: true;
};
export type ShaderParameterId = string & {
  readonly [shader_parameter_id_brand]: true;
};

export function shader_graph_id(value: string): ShaderGraphId {
  return identity(value, "shader graph identity") as ShaderGraphId;
}

export function shader_graph_node_id(value: string): ShaderGraphNodeId {
  return identity(value, "shader graph node identity") as ShaderGraphNodeId;
}

export function shader_parameter_id(value: string): ShaderParameterId {
  return identity(value, "shader parameter identity") as ShaderParameterId;
}

function identity(value: string, label: string): string {
  const parsed = value.trim();
  if (parsed.length === 0 || !/^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(parsed)) {
    throw new Error(
      `${label} ${JSON.stringify(value)} must be nonempty and stable`,
    );
  }
  return parsed;
}
