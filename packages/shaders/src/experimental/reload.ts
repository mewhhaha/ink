import type { ShaderModuleId } from "../identity.ts";
import type { WgslModule } from "../model.ts";

export type ShaderReplacementDecision =
  | {
    readonly type: "rejected";
    readonly reason: string;
  }
  | {
    readonly type: "unchanged";
    readonly module: ShaderModuleId;
  }
  | {
    readonly type: "recompose" | "rebuild_consumers";
    readonly module: ShaderModuleId;
    readonly affected_modules: readonly ShaderModuleId[];
  };

export function decide_shader_replacement(
  current: WgslModule,
  replacement: WgslModule,
  available: readonly WgslModule[],
): ShaderReplacementDecision {
  if (replacement.id !== current.id) {
    return {
      type: "rejected",
      reason:
        `shader replacement ${replacement.id} does not match current module ${current.id}`,
    };
  }
  if (replacement.revision <= current.revision) {
    return {
      type: "rejected",
      reason:
        `shader replacement ${replacement.id} revision ${replacement.revision} must exceed current revision ${current.revision}`,
    };
  }
  const affected = dependent_closure(current.id, available);
  const same_source = current.source === replacement.source;
  const same_dependencies = signature(current.dependencies) ===
    signature(replacement.dependencies);
  const same_contract = interface_signature(current) ===
    interface_signature(replacement);
  if (same_source && same_dependencies && same_contract) {
    return { type: "unchanged", module: current.id };
  }
  return Object.freeze({
    type: same_contract ? "recompose" : "rebuild_consumers",
    module: current.id,
    affected_modules: affected,
  });
}

function dependent_closure(
  changed: ShaderModuleId,
  modules: readonly WgslModule[],
): readonly ShaderModuleId[] {
  const affected = new Set<ShaderModuleId>([changed]);
  let added = true;
  while (added) {
    added = false;
    for (const module of modules) {
      if (
        !affected.has(module.id) &&
        module.dependencies.some((dependency) =>
          affected.has(dependency.module)
        )
      ) {
        affected.add(module.id);
        added = true;
      }
    }
  }
  return Object.freeze([...affected].sort());
}

function interface_signature(module: WgslModule): string {
  return signature({
    symbols: module.symbols.filter((symbol) => symbol.exported),
    overrides: module.overrides,
    bindings: module.bindings,
    entry_points: module.entry_points,
  });
}

function signature(value: unknown): string {
  return JSON.stringify(value);
}
