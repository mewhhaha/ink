import { compile_shader_graph } from "./compile.ts";
import { create_shader_graph } from "./graph.ts";
import { shader_graph_id, shader_graph_node_id } from "./identity.ts";
import type { ShaderGraphNode } from "./model.ts";

const nodes: ShaderGraphNode[] = [{
  id: shader_graph_node_id("constant_0"),
  kind: "constant",
  value_type: "f32",
  value: 1,
}];
for (let index = 1; index < 100; index += 1) {
  nodes.push({
    id: shader_graph_node_id(`constant_${index}`),
    kind: "constant",
    value_type: "f32",
    value: index,
  });
  nodes.push({
    id: shader_graph_node_id(`sum_${index}`),
    kind: "binary",
    value_type: "f32",
    operation: "add",
    left: {
      node: shader_graph_node_id(
        index === 1 ? "constant_0" : `sum_${index - 1}`,
      ),
      socket: "value",
    },
    right: { node: shader_graph_node_id(`constant_${index}`), socket: "value" },
  });
}
const graph = create_shader_graph({
  format: "ink-shader-graph",
  version: 1,
  id: shader_graph_id("benchmark"),
  revision: 0,
  nodes,
  outputs: [{
    name: "value",
    value_type: "f32",
    source: { node: shader_graph_node_id("sum_99"), socket: "value" },
  }],
});

Deno.bench("compile and fold a 199-node shader graph", () => {
  compile_shader_graph(graph);
});
