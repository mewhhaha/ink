import { shader_identifier, shader_module_id } from "./identity.ts";
import type {
  ShaderBindingDeclaration,
  ShaderEntryPoint,
  ShaderOverrideDeclaration,
  ShaderOverrideValue,
  ShaderSymbolDeclaration,
  WgslModule,
  WgslModuleInput,
} from "./model.ts";

export function create_wgsl_module(input: WgslModuleInput): WgslModule {
  const id = shader_module_id(input.id);
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
    throw new Error(
      `shader module ${JSON.stringify(input.id)} revision ${
        JSON.stringify(input.revision)
      } must be nonnegative`,
    );
  }
  if (typeof input.source !== "string") {
    throw new Error(`shader module ${id} source must be a string`);
  }
  const source = input.source.trim();
  if (source.length === 0) {
    throw new Error(
      `shader module ${JSON.stringify(input.id)} source is empty`,
    );
  }
  const dependencies = [...(input.dependencies ?? [])].map((dependency) => {
    const module = shader_module_id(dependency.module);
    const symbols = [...(dependency.symbols ?? [])].map((symbol) =>
      shader_identifier(symbol, `shader ${id} dependency ${module} symbol`)
    ).sort();
    return { module, symbols };
  }).sort((left, right) => left.module.localeCompare(right.module));
  const dependency_ids = new Set<string>();
  for (const dependency of dependencies) {
    if (dependency.module === id) {
      throw new Error(`shader module ${id} depends on itself`);
    }
    if (dependency_ids.has(dependency.module)) {
      throw new Error(
        `shader module ${input.id} repeats dependency ${dependency.module}`,
      );
    }
    dependency_ids.add(dependency.module);
    const required_symbols = [...(dependency.symbols ?? [])].sort();
    if (new Set(required_symbols).size !== required_symbols.length) {
      throw new Error(
        `shader module ${input.id} dependency ${dependency.module} repeats a required symbol`,
      );
    }
  }
  const symbols = validate_symbols(input, source);
  const overrides = validate_overrides(input, source);
  const bindings = validate_bindings(input, source);
  const entry_points = validate_entries(input, source);
  return Object.freeze({
    id,
    revision: input.revision,
    source,
    dependencies: Object.freeze(dependencies.map((value) => {
      const symbols = [...value.symbols].sort();
      return Object.freeze({
        module: value.module,
        ...(symbols.length === 0 ? {} : { symbols: Object.freeze(symbols) }),
      });
    })),
    symbols,
    overrides,
    bindings,
    entry_points,
  });
}

function validate_symbols(
  input: WgslModuleInput,
  source: string,
): readonly ShaderSymbolDeclaration[] {
  const symbols = [...(input.symbols ?? [])].sort((left, right) =>
    left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind)
  );
  const names = new Set<string>();
  for (const symbol of symbols) {
    const name = shader_identifier(symbol.name, `shader ${input.id} symbol`);
    if (names.has(name)) {
      throw new Error(`shader module ${input.id} repeats symbol ${name}`);
    }
    names.add(name);
    if (!["function", "struct", "global"].includes(symbol.kind)) {
      throw new Error(
        `shader module ${input.id} symbol ${name} kind ${
          JSON.stringify(symbol.kind)
        } is unsupported`,
      );
    }
    if (typeof symbol.exported !== "boolean") {
      throw new Error(
        `shader module ${input.id} symbol ${name} exported ${
          JSON.stringify(symbol.exported)
        } must be boolean`,
      );
    }
    const expression = symbol.kind === "function"
      ? `\\bfn\\s+${escape_expression(name)}\\b`
      : symbol.kind === "struct"
      ? `\\bstruct\\s+${escape_expression(name)}\\b`
      : `\\b(?:var|let|const)\\s*(?:<[^>]+>\\s*)?${escape_expression(name)}\\b`;
    if (!new RegExp(expression).test(source)) {
      throw new Error(
        `shader module ${input.id} declares absent ${symbol.kind} ${name}`,
      );
    }
  }
  return Object.freeze(
    symbols.map((value) =>
      Object.freeze({ ...value, name: value.name.trim() })
    ),
  );
}

function validate_overrides(
  input: WgslModuleInput,
  source: string,
): readonly ShaderOverrideDeclaration[] {
  const overrides = [...(input.overrides ?? [])].sort((left, right) =>
    left.name.localeCompare(right.name)
  );
  const names = new Set<string>();
  for (const declaration of overrides) {
    const name = shader_identifier(
      declaration.name,
      `shader ${input.id} override`,
    );
    if (names.has(name)) {
      throw new Error(`shader module ${input.id} repeats override ${name}`);
    }
    names.add(name);
    if (!["bool", "i32", "u32", "f32"].includes(declaration.type)) {
      throw new Error(
        `shader module ${input.id} override ${name} type ${
          JSON.stringify(declaration.type)
        } is unsupported`,
      );
    }
    validate_override_value(
      input.id,
      declaration.type,
      declaration.default_value,
    );
    const expression = new RegExp(
      `\\boverride\\s+${
        escape_expression(name)
      }\\s*:\\s*${declaration.type}\\s*=\\s*([^;]+)\\s*;`,
    );
    const match = source.match(expression);
    if (match === null) {
      throw new Error(
        `shader module ${input.id} declares absent override ${name}:${declaration.type}`,
      );
    }
    validate_override_source_default(input.id, declaration, match[1].trim());
  }
  return Object.freeze(
    overrides.map((value) =>
      Object.freeze({ ...value, name: value.name.trim() })
    ),
  );
}

function validate_override_source_default(
  module: string,
  declaration: ShaderOverrideDeclaration,
  source: string,
): void {
  const parsed = source.length === 0
    ? undefined
    : declaration.type === "bool"
    ? source === "true" ? true : source === "false" ? false : undefined
    : Number(source.replaceAll("_", "").replace(/[iufh]$/, ""));
  if (parsed === undefined || !Object.is(parsed, declaration.default_value)) {
    throw new Error(
      `shader module ${module} override ${declaration.name} source default ${
        JSON.stringify(source)
      } does not match declared default ${
        JSON.stringify(declaration.default_value)
      }`,
    );
  }
}

function validate_override_value(
  module: string,
  type: ShaderOverrideDeclaration["type"],
  value: ShaderOverrideValue,
): void {
  if (type === "bool") {
    if (typeof value !== "boolean") {
      throw new Error(
        `shader module ${module} bool override default ${
          JSON.stringify(value)
        } must be boolean`,
      );
    }
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `shader module ${module} ${type} override default ${
        JSON.stringify(value)
      } must be finite`,
    );
  }
  if ((type === "i32" || type === "u32") && !Number.isSafeInteger(value)) {
    throw new Error(
      `shader module ${module} ${type} override default ${value} must be an integer`,
    );
  }
  if (type === "u32" && value < 0) {
    throw new Error(
      `shader module ${module} u32 override default ${value} must be nonnegative`,
    );
  }
}

function validate_bindings(
  input: WgslModuleInput,
  source: string,
): readonly ShaderBindingDeclaration[] {
  const bindings = [...(input.bindings ?? [])].sort((left, right) =>
    left.group - right.group || left.binding - right.binding
  );
  const slots = new Set<string>();
  const names = new Set<string>();
  for (const declaration of bindings) {
    const slot = `${declaration.group}:${declaration.binding}`;
    if (
      !Number.isSafeInteger(declaration.group) || declaration.group < 0 ||
      !Number.isSafeInteger(declaration.binding) || declaration.binding < 0
    ) {
      throw new Error(`shader module ${input.id} binding ${slot} is invalid`);
    }
    if (slots.has(slot)) {
      throw new Error(`shader module ${input.id} repeats binding ${slot}`);
    }
    slots.add(slot);
    const name = shader_identifier(
      declaration.name,
      `shader ${input.id} binding`,
    );
    if (names.has(name)) {
      throw new Error(`shader module ${input.id} repeats binding name ${name}`);
    }
    names.add(name);
    if (
      ![
        "uniform",
        "read_only_storage",
        "storage",
        "texture",
        "storage_texture",
        "sampler",
        "comparison_sampler",
      ].includes(declaration.kind)
    ) {
      throw new Error(
        `shader module ${input.id} binding ${slot} kind ${
          JSON.stringify(declaration.kind)
        } is unsupported`,
      );
    }
    if (!Array.isArray(declaration.stages)) {
      throw new Error(
        `shader module ${input.id} binding ${slot} stages must be an array`,
      );
    }
    if (declaration.stages.length === 0) {
      throw new Error(
        `shader module ${input.id} binding ${slot} has no stages`,
      );
    }
    const stages = new Set(declaration.stages);
    if (stages.size !== declaration.stages.length) {
      throw new Error(
        `shader module ${input.id} binding ${slot} repeats a stage`,
      );
    }
    for (const stage of stages) {
      validate_stage(input.id, stage, `binding ${slot}`);
    }
    if (typeof declaration.value_type !== "string") {
      throw new Error(
        `shader module ${input.id} binding ${slot} value type must be a string`,
      );
    }
    const address_space = declaration.kind === "uniform"
      ? "<\\s*uniform\\s*>"
      : declaration.kind === "read_only_storage"
      ? "<\\s*storage\\s*,\\s*read\\s*>"
      : declaration.kind === "storage"
      ? "<\\s*storage\\s*,\\s*read_write\\s*>"
      : "";
    const expression = new RegExp(
      `@group\\(\\s*${declaration.group}\\s*\\)\\s*@binding\\(\\s*${declaration.binding}\\s*\\)\\s*var${address_space}\\s+${
        escape_expression(name)
      }\\s*:\\s*${escape_expression(declaration.value_type)}\\s*;`,
    );
    if (!expression.test(source)) {
      throw new Error(
        `shader module ${input.id} binding ${slot} ${name} is absent from WGSL source`,
      );
    }
    if (declaration.value_type.trim().length === 0) {
      throw new Error(
        `shader module ${input.id} binding ${slot} value type cannot be empty`,
      );
    }
    validate_binding_kind(input.id, declaration);
  }
  return Object.freeze(bindings.map((value) =>
    Object.freeze({
      ...value,
      name: value.name.trim(),
      value_type: value.value_type.trim(),
      stages: Object.freeze([...value.stages].sort()),
    })
  ));
}

function validate_binding_kind(
  module: string,
  declaration: ShaderBindingDeclaration,
): void {
  const type = declaration.value_type.trim();
  const valid = declaration.kind === "texture"
    ? type.startsWith("texture_") && !type.startsWith("texture_storage_")
    : declaration.kind === "storage_texture"
    ? type.startsWith("texture_storage_")
    : declaration.kind === "sampler"
    ? type === "sampler"
    : declaration.kind === "comparison_sampler"
    ? type === "sampler_comparison"
    : true;
  if (!valid) {
    throw new Error(
      `shader module ${module} binding ${declaration.group}:${declaration.binding} kind ${declaration.kind} does not match value type ${
        JSON.stringify(declaration.value_type)
      }`,
    );
  }
}

function validate_entries(
  input: WgslModuleInput,
  source: string,
): readonly ShaderEntryPoint[] {
  const entries = [...(input.entry_points ?? [])].sort((left, right) =>
    left.stage.localeCompare(right.stage) || left.name.localeCompare(right.name)
  );
  const stages = new Set<string>();
  for (const entry of entries) {
    const name = shader_identifier(
      entry.name,
      `shader ${input.id} entry point`,
    );
    validate_stage(input.id, entry.stage, `entry ${name}`);
    if (stages.has(entry.stage)) {
      throw new Error(
        `shader module ${input.id} repeats ${entry.stage} entry point`,
      );
    }
    stages.add(entry.stage);
    const expression = new RegExp(
      `@${entry.stage}\\s+(?:@[A-Za-z_][A-Za-z0-9_]*(?:\\([^\\n)]*\\))?\\s+)*fn\\s+${
        escape_expression(name)
      }\\b`,
    );
    if (!expression.test(source)) {
      throw new Error(
        `shader module ${input.id} ${entry.stage} entry ${name} is absent from WGSL source`,
      );
    }
  }
  return Object.freeze(
    entries.map((value) =>
      Object.freeze({ ...value, name: value.name.trim() })
    ),
  );
}

function escape_expression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validate_stage(module: string, stage: string, owner: string): void {
  if (!["vertex", "fragment", "compute"].includes(stage)) {
    throw new Error(
      `shader module ${module} ${owner} stage ${
        JSON.stringify(stage)
      } is unsupported`,
    );
  }
}
