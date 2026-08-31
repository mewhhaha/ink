import {
  compose_wgsl_modules,
  shader_program_contract,
} from "@ink/shaders/compose.ts";
import { shader_module_id } from "@ink/shaders/identity.ts";
import { create_wgsl_module } from "@ink/shaders/module.ts";
import { assertEquals, assertThrows } from "@std/assert";
import { rendering_shader_definition } from "./experimental/shader_contract.ts";

Deno.test("composed shader contracts retain entries and bindings at the rendering boundary", () => {
  const module = create_wgsl_module({
    id: shader_module_id("acceptance/surface"),
    revision: 3,
    source: `
struct Frame { projection: mat4x4f }
@group(0) @binding(0) var<uniform> frame: Frame;
@vertex fn vertex_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  return frame.projection * vec4f(f32(index), 0.0, 0.0, 1.0);
}
@fragment fn fragment_main() -> @location(0) vec4f {
  return vec4f(1.0);
}`,
    bindings: [{
      group: 0,
      binding: 0,
      name: "frame",
      kind: "uniform",
      stages: ["vertex"],
      value_type: "Frame",
    }],
    entry_points: [
      { stage: "vertex", name: "vertex_main" },
      { stage: "fragment", name: "fragment_main" },
    ],
  });
  const source = compose_wgsl_modules([module.id], [module]);
  const definition = rendering_shader_definition(
    shader_program_contract(source),
  );
  assertEquals(definition.id, "acceptance/surface");
  assertEquals(definition.revision, 3);
  assertEquals(definition.reflection.vertex_entry, "vertex_main");
  assertEquals(definition.reflection.fragment_entry, "fragment_main");
  assertEquals(definition.reflection.bindings, [{
    group: 0,
    binding: 0,
    name: "frame",
    visibility: ["vertex"],
    kind: "uniform",
  }]);
  assertThrows(
    () =>
      rendering_shader_definition(shader_program_contract(source), { id: " " }),
    Error,
    'shader module identity " " must be nonempty and stable',
  );
});
