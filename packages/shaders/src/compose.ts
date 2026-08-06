import type { ShaderModuleId } from "./identity.ts";
import type {
  ComposedShaderSource,
  ResolvedShaderVariant,
  ShaderBindingDeclaration,
  ShaderEntryPoint,
  ShaderOverrideDeclaration,
  ShaderProgramContract,
  ShaderSymbolDeclaration,
  WgslModule,
} from "./model.ts";

export function compose_wgsl_modules(
  roots: readonly ShaderModuleId[],
  available: readonly WgslModule[],
  variant?: ResolvedShaderVariant,
): ComposedShaderSource {
  if (roots.length === 0) {
    throw new Error("shader composition requires at least one root module");
  }
  const modules_by_id = new Map<ShaderModuleId, WgslModule>();
  for (const module of available) {
    const current = modules_by_id.get(module.id);
    if (current !== undefined) {
      throw new Error(
        `shader composition repeats module ${module.id} revisions ${current.revision} and ${module.revision}`,
      );
    }
    modules_by_id.set(module.id, module);
  }
  const ordered_roots = [...new Set(roots)].sort();
  if (ordered_roots.length !== roots.length) {
    throw new Error("shader composition repeats a root module");
  }
  const ordered: WgslModule[] = [];
  const visited = new Set<ShaderModuleId>();
  const visiting: ShaderModuleId[] = [];
  const visit = (id: ShaderModuleId): void => {
    if (visited.has(id)) return;
    const cycle_index = visiting.indexOf(id);
    if (cycle_index >= 0) {
      throw new Error(
        `shader dependency cycle ${
          [...visiting.slice(cycle_index), id].join(" -> ")
        }`,
      );
    }
    const module = modules_by_id.get(id);
    if (module === undefined) {
      const owner = visiting.at(-1);
      throw new Error(
        owner === undefined
          ? `shader root module ${id} is unavailable`
          : `shader module ${owner} dependency ${id} is unavailable`,
      );
    }
    visiting.push(id);
    for (const dependency of module.dependencies) visit(dependency.module);
    visiting.pop();
    visited.add(id);
    ordered.push(module);
  };
  for (const root of ordered_roots) visit(root);

  const symbols = merge_symbols(ordered);
  validate_dependency_symbols(ordered, modules_by_id);
  const overrides = merge_overrides(ordered);
  const bindings = merge_bindings(ordered);
  const entry_points = merge_entries(ordered);
  validate_declared_namespace(ordered);
  const lines: string[] = [];
  const source_map = ordered.map((module) => {
    lines.push(`// @ink module ${module.id} revision ${module.revision}`);
    const generated_start_line = lines.length + 1;
    const module_lines = module.source.split("\n");
    lines.push(...module_lines);
    const generated_end_line = lines.length;
    lines.push("");
    return Object.freeze({
      module: module.id,
      generated_start_line,
      generated_end_line,
      source_start_line: 1,
    });
  });
  return Object.freeze({
    roots: Object.freeze(ordered_roots),
    modules: Object.freeze(ordered),
    source: lines.join("\n").trimEnd(),
    source_map: Object.freeze(source_map),
    symbols,
    overrides,
    bindings,
    entry_points,
    ...(variant === undefined ? {} : {
      variant: Object.freeze({
        ...variant,
        values: Object.freeze({ ...variant.values }),
      }),
    }),
  });
}

function validate_dependency_symbols(
  modules: readonly WgslModule[],
  modules_by_id: ReadonlyMap<ShaderModuleId, WgslModule>,
): void {
  for (const module of modules) {
    for (const dependency of module.dependencies) {
      const exported = new Set(
        modules_by_id.get(dependency.module)!.symbols.filter(({ exported }) =>
          exported
        ).map(({ name }) => name),
      );
      for (const symbol of dependency.symbols ?? []) {
        if (!exported.has(symbol)) {
          throw new Error(
            `shader module ${module.id} dependency ${dependency.module} does not export required symbol ${symbol}`,
          );
        }
      }
    }
  }
}

export function shader_program_contract(
  source: ComposedShaderSource,
): ShaderProgramContract {
  const entries = new Map(
    source.entry_points.map((entry) => [entry.stage, entry]),
  );
  if (entries.size === 0) {
    throw new Error(
      `shader program roots ${source.roots.join(", ")} have no entry points`,
    );
  }
  return Object.freeze({
    source,
    ...(entries.get("vertex") === undefined
      ? {}
      : { vertex_entry: entries.get("vertex")!.name }),
    ...(entries.get("fragment") === undefined
      ? {}
      : { fragment_entry: entries.get("fragment")!.name }),
    ...(entries.get("compute") === undefined
      ? {}
      : { compute_entry: entries.get("compute")!.name }),
  });
}

function merge_symbols(
  modules: readonly WgslModule[],
): readonly ShaderSymbolDeclaration[] {
  const declared = new Map<
    string,
    { module: ShaderModuleId; exported: boolean }
  >();
  const symbols: ShaderSymbolDeclaration[] = [];
  for (const module of modules) {
    for (const symbol of module.symbols) {
      const owner = declared.get(symbol.name);
      if (owner !== undefined) {
        const operation = owner.exported || symbol.exported
          ? "export"
          : "declare";
        throw new Error(
          `shader modules ${owner.module} and ${module.id} ${operation} symbol ${symbol.name}`,
        );
      }
      declared.set(symbol.name, {
        module: module.id,
        exported: symbol.exported,
      });
      symbols.push(symbol);
    }
  }
  return Object.freeze(symbols);
}

function merge_overrides(
  modules: readonly WgslModule[],
): readonly ShaderOverrideDeclaration[] {
  const by_name = new Map<string, ShaderModuleId>();
  return Object.freeze(
    modules.flatMap((module) =>
      module.overrides.map((declaration) => {
        const owner = by_name.get(declaration.name);
        if (owner !== undefined) {
          throw new Error(
            `shader modules ${owner} and ${module.id} declare override ${declaration.name}`,
          );
        }
        by_name.set(declaration.name, module.id);
        return declaration;
      })
    ),
  );
}

function merge_bindings(
  modules: readonly WgslModule[],
): readonly ShaderBindingDeclaration[] {
  const slots = new Map<
    string,
    { module: ShaderModuleId; binding: ShaderBindingDeclaration }
  >();
  const bindings: ShaderBindingDeclaration[] = [];
  for (const module of modules) {
    for (const binding of module.bindings) {
      const slot = `${binding.group}:${binding.binding}`;
      const current = slots.get(slot);
      if (current !== undefined) {
        throw new Error(
          `shader modules ${current.module} and ${module.id} both own binding ${slot}`,
        );
      }
      slots.set(slot, { module: module.id, binding });
      bindings.push(binding);
    }
  }
  return Object.freeze(
    bindings.sort((left, right) =>
      left.group - right.group || left.binding - right.binding
    ),
  );
}

function merge_entries(
  modules: readonly WgslModule[],
): readonly ShaderEntryPoint[] {
  const stages = new Map<string, ShaderModuleId>();
  const entries: ShaderEntryPoint[] = [];
  for (const module of modules) {
    for (const entry of module.entry_points) {
      const owner = stages.get(entry.stage);
      if (owner !== undefined) {
        throw new Error(
          `shader modules ${owner} and ${module.id} both declare ${entry.stage} entry points`,
        );
      }
      stages.set(entry.stage, module.id);
      entries.push(entry);
    }
  }
  return Object.freeze(
    entries.sort((left, right) => left.stage.localeCompare(right.stage)),
  );
}

function validate_declared_namespace(modules: readonly WgslModule[]): void {
  const owners = new Map<string, ShaderModuleId>();
  for (const module of modules) {
    for (
      const name of [
        ...module.symbols.map(({ name }) => name),
        ...module.entry_points.map(({ name }) => name),
      ]
    ) {
      const owner = owners.get(name);
      if (owner !== undefined && owner !== module.id) {
        throw new Error(
          `shader modules ${owner} and ${module.id} declare WGSL name ${name}`,
        );
      }
      owners.set(name, module.id);
    }
  }
}
