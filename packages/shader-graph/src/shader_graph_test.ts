import { compose_wgsl_modules } from "@ink/shaders/compose.ts";
import { shader_module_id } from "@ink/shaders/identity.ts";
import { create_wgsl_module } from "@ink/shaders/module.ts";
import { compile_shader_graph } from "./experimental/compile.ts";
import {
  create_shader_graph,
  shader_graph_sockets,
} from "./experimental/graph.ts";
import {
  shader_graph_id,
  shader_graph_node_id,
  shader_parameter_id,
} from "./experimental/identity.ts";
import type {
  ShaderGraphInput,
  ShaderGraphNode,
} from "./experimental/model.ts";
import {
  parse_shader_graph,
  serialize_shader_graph,
} from "./experimental/serialization.ts";
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";

function connection(node: string) {
  return { node: shader_graph_node_id(node), socket: "value" as const };
}

function graph_input(nodes?: readonly ShaderGraphNode[]): ShaderGraphInput {
  return {
    format: "ink-shader-graph",
    version: 1,
    id: shader_graph_id("surface"),
    revision: 3,
    nodes: nodes ?? [
      {
        id: shader_graph_node_id("first"),
        kind: "constant",
        value_type: "f32",
        value: 1,
      },
      {
        id: shader_graph_node_id("second"),
        kind: "constant",
        value_type: "f32",
        value: 2,
      },
      {
        id: shader_graph_node_id("sum"),
        kind: "binary",
        value_type: "f32",
        operation: "add",
        left: connection("first"),
        right: connection("second"),
      },
      {
        id: shader_graph_node_id("strength"),
        kind: "parameter",
        parameter: shader_parameter_id("strength"),
        value_type: "f32",
        default_value: 0.5,
      },
      {
        id: shader_graph_node_id("result"),
        kind: "binary",
        value_type: "f32",
        operation: "multiply",
        left: connection("sum"),
        right: connection("strength"),
      },
      {
        id: shader_graph_node_id("dead"),
        kind: "constant",
        value_type: "f32",
        value: 100,
      },
    ],
    outputs: [{
      name: "roughness",
      value_type: "f32",
      source: connection("result"),
    }],
  };
}

Deno.test("typed sockets expose node inputs and one immutable value output", () => {
  const graph = create_shader_graph(graph_input());
  const result = graph.nodes.find(({ id }) => id === "result")!;
  assertEquals(shader_graph_sockets(result), [
    { name: "left", direction: "input", value_type: "f32" },
    { name: "right", direction: "input", value_type: "f32" },
    { name: "value", direction: "output", value_type: "f32" },
  ]);
  assertEquals(Object.isFrozen(graph.nodes), true);
  assertEquals(Object.isFrozen(result), true);
  const vector = create_shader_graph({
    format: "ink-shader-graph",
    version: 1,
    id: shader_graph_id("vector"),
    revision: 0,
    nodes: [{
      id: shader_graph_node_id("color"),
      kind: "constant",
      value_type: "vec3f",
      value: [1, 0.5, 0],
    }],
    outputs: [{
      name: "color",
      value_type: "vec3f",
      source: connection("color"),
    }],
  });
  const color = vector.nodes[0];
  if (color.kind !== "constant") throw new Error(`color became ${color.kind}`);
  assertEquals(Object.isFrozen(color.value), true);
});

Deno.test("direct construction canonicalizes graph identities and rejects unknown operations", () => {
  const graph = create_shader_graph({
    format: "ink-shader-graph",
    version: 1,
    id: shader_graph_id(" canonical "),
    revision: 0,
    nodes: [{
      id: shader_graph_node_id(" value "),
      kind: "constant",
      value_type: "f32",
      value: 1,
    }],
    outputs: [{
      name: " result ",
      value_type: "f32",
      source: connection(" value "),
    }],
  });
  assertEquals(graph.id, "canonical");
  assertEquals(graph.nodes[0].id, "value");
  assertEquals(graph.outputs[0].name, "result");

  const invalid = graph_input([{
    id: shader_graph_node_id("invalid"),
    kind: "binary",
    value_type: "f32",
    operation: "modulo",
    left: connection("invalid"),
    right: connection("invalid"),
  } as never]);
  assertThrows(
    () => create_shader_graph(invalid),
    Error,
    'operation "modulo" is unsupported',
  );
});

Deno.test("compilation folds constants, removes unreachable nodes, and emits stable WGSL", () => {
  const first = compile_shader_graph(create_shader_graph(graph_input()));
  const second = compile_shader_graph(create_shader_graph(graph_input(
    [...graph_input().nodes].reverse(),
  )));
  assertEquals(first.module.source, second.module.source);
  assertEquals(first.folded_nodes, ["sum"]);
  assertEquals(first.eliminated_nodes, ["dead"]);
  assertEquals(first.parameters, [{
    id: shader_parameter_id("strength"),
    value_type: "f32",
    default_value: 0.5,
  }]);
  assertStringIncludes(first.module.source, "(3.0 * parameter_id_");
  assertStringIncludes(first.module.source, "fn ink_graph_id_");
});

Deno.test("call nodes produce explicit module dependencies consumable by shader composition", () => {
  const external = create_wgsl_module({
    id: shader_module_id("fixture/curve"),
    revision: 0,
    symbols: [{ name: "fixture_curve", kind: "function", exported: true }],
    source: "fn fixture_curve(value: f32) -> f32 { return value * value; }",
  });
  const graph = create_shader_graph({
    format: "ink-shader-graph",
    version: 1,
    id: shader_graph_id("curve"),
    revision: 0,
    nodes: [
      {
        id: shader_graph_node_id("value"),
        kind: "constant",
        value_type: "f32",
        value: 0.5,
      },
      {
        id: shader_graph_node_id("curve"),
        kind: "call",
        value_type: "f32",
        module: external.id,
        function: "fixture_curve",
        arguments: [{
          name: "value",
          value_type: "f32",
          source: connection("value"),
        }],
      },
    ],
    outputs: [{
      name: "value",
      value_type: "f32",
      source: connection("curve"),
    }],
  });
  const compiled = compile_shader_graph(graph);
  assertEquals(compiled.module.dependencies, [{
    module: external.id,
    symbols: ["fixture_curve"],
  }]);
  assertEquals(
    compose_wgsl_modules([compiled.module.id], [compiled.module, external])
      .modules.map(({ id }) => id),
    [external.id, compiled.module.id],
  );
});

Deno.test("integer folding preserves WGSL division and skips invalid unsigned subtraction", () => {
  const integer_graph = create_shader_graph({
    format: "ink-shader-graph",
    version: 1,
    id: shader_graph_id("integers"),
    revision: 0,
    nodes: [
      {
        id: shader_graph_node_id("five"),
        kind: "constant",
        value_type: "i32",
        value: 5,
      },
      {
        id: shader_graph_node_id("two"),
        kind: "constant",
        value_type: "i32",
        value: 2,
      },
      {
        id: shader_graph_node_id("divide"),
        kind: "binary",
        value_type: "i32",
        operation: "divide",
        left: connection("five"),
        right: connection("two"),
      },
    ],
    outputs: [{
      name: "value",
      value_type: "i32",
      source: connection("divide"),
    }],
  });
  const divided = compile_shader_graph(integer_graph);
  assertEquals(divided.folded_nodes, ["divide"]);
  assertStringIncludes(divided.module.source, "return 2;");

  const unsigned_graph = create_shader_graph({
    format: "ink-shader-graph",
    version: 1,
    id: shader_graph_id("unsigned"),
    revision: 0,
    nodes: [
      {
        id: shader_graph_node_id("zero"),
        kind: "constant",
        value_type: "u32",
        value: 0,
      },
      {
        id: shader_graph_node_id("one"),
        kind: "constant",
        value_type: "u32",
        value: 1,
      },
      {
        id: shader_graph_node_id("subtract"),
        kind: "binary",
        value_type: "u32",
        operation: "subtract",
        left: connection("zero"),
        right: connection("one"),
      },
    ],
    outputs: [{
      name: "value",
      value_type: "u32",
      source: connection("subtract"),
    }],
  });
  const subtracted = compile_shader_graph(unsigned_graph);
  assertEquals(subtracted.folded_nodes, []);
  assertStringIncludes(subtracted.module.source, "(0u - 1u)");
});

Deno.test("graph validation reports cycles with the exact node path", () => {
  assertThrows(
    () =>
      create_shader_graph(graph_input([
        {
          id: shader_graph_node_id("first"),
          kind: "binary",
          value_type: "f32",
          operation: "add",
          left: connection("second"),
          right: connection("second"),
        },
        {
          id: shader_graph_node_id("second"),
          kind: "binary",
          value_type: "f32",
          operation: "multiply",
          left: connection("first"),
          right: connection("first"),
        },
      ])),
    Error,
    "cycle first -> second -> first",
  );
});

Deno.test("graph validation rejects missing nodes and socket type mismatches", () => {
  assertThrows(
    () =>
      create_shader_graph(graph_input([{
        id: shader_graph_node_id("broken"),
        kind: "unary",
        operation: "negate",
        value_type: "f32",
        source: connection("missing"),
      }])),
    Error,
    "references missing node missing",
  );
  assertThrows(
    () =>
      create_shader_graph(graph_input([
        {
          id: shader_graph_node_id("integer"),
          kind: "constant",
          value_type: "i32",
          value: 1,
        },
        {
          id: shader_graph_node_id("float"),
          kind: "constant",
          value_type: "f32",
          value: 1,
        },
        {
          id: shader_graph_node_id("broken"),
          kind: "binary",
          operation: "add",
          value_type: "f32",
          left: connection("integer"),
          right: connection("float"),
        },
      ])),
    Error,
    "socket left expects f32 but node integer provides i32",
  );
});

Deno.test("versioned serialization round trips canonically and rejects future versions", () => {
  const graph = create_shader_graph(graph_input());
  const serialized = serialize_shader_graph(graph);
  assertEquals(
    serialize_shader_graph(parse_shader_graph(serialized)),
    serialized,
  );
  assertThrows(
    () => parse_shader_graph(serialized.replace('"version":1', '"version":2')),
    Error,
    "version 2 is unsupported",
  );
  assertThrows(
    () => parse_shader_graph("{"),
    Error,
    "could not be parsed",
  );
});
