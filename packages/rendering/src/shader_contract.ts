import type { ShaderProgramContract } from "@ink/shaders/model.ts";
import { type ShaderModuleDefinition, validate_shader } from "./shader.ts";

export interface RenderingShaderOptions {
  readonly id?: string;
}

export function rendering_shader_definition(
  contract: ShaderProgramContract,
  options: RenderingShaderOptions = {},
): ShaderModuleDefinition {
  const id = options.id === undefined
    ? contract.source.roots.join("+")
    : options.id;
  const revision = contract.source.modules.reduce(
    (maximum, module) => Math.max(maximum, module.revision),
    0,
  );
  return validate_shader({
    id,
    revision,
    source: contract.source.source,
    reflection: {
      ...(contract.vertex_entry === undefined
        ? {}
        : { vertex_entry: contract.vertex_entry }),
      ...(contract.fragment_entry === undefined
        ? {}
        : { fragment_entry: contract.fragment_entry }),
      ...(contract.compute_entry === undefined
        ? {}
        : { compute_entry: contract.compute_entry }),
      bindings: contract.source.bindings.map((binding) => ({
        group: binding.group,
        binding: binding.binding,
        name: binding.name,
        visibility: binding.stages,
        kind: binding.kind,
      })),
    },
  });
}
