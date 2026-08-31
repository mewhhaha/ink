export type BlotAbiType =
  | { readonly kind: "unit" }
  | { readonly kind: "signed-integer-64" }
  | { readonly kind: "float-32" }
  | { readonly kind: "float-64" }
  | { readonly kind: "boolean" }
  | { readonly kind: "text" }
  | { readonly kind: "array"; readonly element: BlotAbiType }
  | {
    readonly kind: "record";
    readonly fields: readonly {
      readonly name: string;
      readonly type: BlotAbiType;
    }[];
  }
  | {
    readonly kind: "variant";
    readonly cases: readonly {
      readonly name: string;
      readonly payload?: BlotAbiType;
    }[];
  }
  | {
    readonly kind: "sealed";
    readonly name: string;
    readonly inner: BlotAbiType;
  };

export interface BlotAbiFunction {
  readonly parameters: readonly BlotAbiType[];
  readonly result: BlotAbiType;
}

type BlotCoreValue = "i32" | "i64" | "f32" | "f64";

export interface BlotHostImportCodec {
  readonly flat_parameters: readonly BlotCoreValue[];
  readonly flat_result: readonly BlotCoreValue[];
  readonly wasm_parameters: readonly BlotCoreValue[];
  readonly wasm_result: readonly BlotCoreValue[];
  readonly parameter_passing: "flat" | "indirect";
  readonly result_passing: "none" | "direct" | "indirect";
}

export interface BlotHostImportDeclaration {
  readonly capability: string;
  readonly operation: string;
  readonly module: string;
  readonly name: string;
  readonly function: BlotAbiFunction;
  readonly ownership: {
    readonly input: "unrestricted";
    readonly result: "unrestricted";
  };
  readonly codec: BlotHostImportCodec;
}

const abi_policy = {
  major: 2,
  minor: 0,
  coreSpecification: "3.0",
  memory: "memory32",
  stringEncoding: "utf-8",
  maximumFlatParameters: 16,
  maximumFlatResults: 1,
  memoryExport: "memory",
  reallocExport: "cabi_realloc",
} as const;

const unit = { kind: "unit" } as const;
const integer = { kind: "signed-integer-64" } as const;
const boolean = { kind: "boolean" } as const;
const text = { kind: "text" } as const;

type NamedAbiFields<
  fields extends readonly (readonly [name: string, type: BlotAbiType])[],
> = {
  readonly [index in keyof fields]: fields[index] extends readonly [
    name: infer name extends string,
    type: infer type extends BlotAbiType,
  ] ? { readonly name: name; readonly type: type }
    : never;
};

function record<
  const fields extends readonly (
    readonly [name: string, type: BlotAbiType]
  )[],
>(
  fields: fields,
): { readonly kind: "record"; readonly fields: NamedAbiFields<fields> } {
  return {
    kind: "record",
    fields: fields.map(([name, type]) => ({ name, type })),
  } as {
    readonly kind: "record";
    readonly fields: NamedAbiFields<fields>;
  };
}

function integer_record<const names extends readonly string[]>(
  ...names: names
): {
  readonly kind: "record";
  readonly fields: {
    readonly [index in keyof names]: {
      readonly name: names[index];
      readonly type: typeof integer;
    };
  };
} {
  return {
    kind: "record",
    fields: names.map((name) => ({ name, type: integer })),
  } as {
    readonly kind: "record";
    readonly fields: {
      readonly [index in keyof names]: {
        readonly name: names[index];
        readonly type: typeof integer;
      };
    };
  };
}

function host_import<
  const capability extends string,
  const operation extends string,
  const parameter extends BlotAbiType,
  const result extends BlotAbiType,
>(
  capability: capability,
  operation: operation,
  parameter: parameter,
  result: result,
) {
  const function_ = { parameters: [parameter] as const, result };
  return {
    capability,
    operation,
    module: `blot:host/${capability}`,
    name: operation,
    function: function_,
    ownership: { input: "unrestricted", result: "unrestricted" },
    codec: host_import_codec(function_),
  } as const;
}

function host_import_codec(function_: BlotAbiFunction): BlotHostImportCodec {
  const flat_parameters = function_.parameters.flatMap(flatten_abi_type);
  const flat_result = flatten_abi_type(function_.result);
  const parameter_passing =
    flat_parameters.length > abi_policy.maximumFlatParameters
      ? "indirect"
      : "flat";
  const result_passing = flat_result.length === 0
    ? "none"
    : flat_result.length <= abi_policy.maximumFlatResults
    ? "direct"
    : "indirect";
  const wasm_parameters = parameter_passing === "indirect"
    ? ["i32" as const]
    : flat_parameters;
  return {
    flat_parameters,
    flat_result,
    wasm_parameters: result_passing === "indirect"
      ? [...wasm_parameters, "i32"]
      : wasm_parameters,
    wasm_result: result_passing === "direct" ? flat_result : [],
    parameter_passing,
    result_passing,
  };
}

function flatten_abi_type(type: BlotAbiType): readonly BlotCoreValue[] {
  switch (type.kind) {
    case "unit":
      return [];
    case "signed-integer-64":
      return ["i64"];
    case "float-32":
      return ["f32"];
    case "float-64":
      return ["f64"];
    case "boolean":
      return ["i32"];
    case "text":
    case "array":
      return ["i32", "i32"];
    case "record":
      return type.fields.flatMap((field) => flatten_abi_type(field.type));
    case "sealed":
      return flatten_abi_type(type.inner);
    case "variant": {
      let payload: readonly BlotCoreValue[] = [];
      for (const variant_case of type.cases) {
        const current = variant_case.payload === undefined
          ? []
          : flatten_abi_type(variant_case.payload);
        payload = joined_core_values(payload, current);
      }
      return ["i32", ...payload];
    }
  }
}

function joined_core_values(
  left: readonly BlotCoreValue[],
  right: readonly BlotCoreValue[],
): readonly BlotCoreValue[] {
  return Array.from(
    { length: Math.max(left.length, right.length) },
    (_, index): BlotCoreValue => {
      const left_value = left[index];
      const right_value = right[index];
      if (left_value === undefined) return right_value ?? "i32";
      if (right_value === undefined || left_value === right_value) {
        return left_value;
      }
      if (
        (left_value === "i32" || left_value === "f32") &&
        (right_value === "i32" || right_value === "f32")
      ) {
        return "i32";
      }
      return "i64";
    },
  );
}

const host_imports = [
  host_import("Cells", "get", integer, integer),
  host_import(
    "Cells",
    "put",
    integer_record("index", "value"),
    unit,
  ),
  host_import(
    "DataAsset",
    "copy_to_cells",
    integer_record("asset", "field", "first_cell"),
    unit,
  ),
  host_import(
    "DataAsset",
    "get",
    integer_record("asset", "field", "index"),
    integer,
  ),
  host_import(
    "DataAsset",
    "length",
    integer_record("asset", "field"),
    integer,
  ),
  host_import(
    "EcsSchema",
    "component",
    record([
      ["field_count", integer],
      ["fields", text],
      ["id", integer],
      ["name", text],
    ]),
    unit,
  ),
  host_import(
    "EcsSchema",
    "resource",
    record([
      ["field_count", integer],
      ["fields", text],
      ["id", integer],
      ["name", text],
      ["source", text],
    ]),
    unit,
  ),
  host_import(
    "EcsSchema",
    "seed_indexed",
    record([
      ["component", integer],
      ["source", text],
      ["world_base", integer],
    ]),
    unit,
  ),
  host_import(
    "EcsSchema",
    "world",
    integer_record(
      "base",
      "capacity",
      "component_base",
      "component_capacity",
      "component_stride",
      "entity_metadata_base",
      "entity_mode",
      "max_fields",
      "resource_base",
      "resource_capacity",
      "resource_stride",
    ),
    unit,
  ),
  host_import(
    "Events",
    "next",
    unit,
    integer_record("kind", "target", "value"),
  ),
  host_import(
    "HostEffect",
    "play_audio",
    record([
      ["cue", text],
      ["id", text],
    ]),
    unit,
  ),
  host_import("Phase", "current", unit, integer),
  host_import(
    "Render",
    "directional_light",
    integer_record(
      "color_blue",
      "color_green",
      "color_red",
      "direction_x",
      "direction_y",
      "direction_z",
      "intensity",
    ),
    unit,
  ),
  host_import(
    "Render",
    "environment",
    integer_record(
      "ambient_blue",
      "ambient_green",
      "ambient_red",
      "bloom_intensity",
      "exposure_ev100",
      "fog_blue",
      "fog_density",
      "fog_green",
      "fog_red",
    ),
    unit,
  ),
  host_import(
    "Render",
    "material",
    integer_record(
      "blend_edges",
      "color_blue",
      "color_green",
      "color_red",
      "id",
      "path_connections",
      "secondary_texture",
      "surface_mode",
      "texture",
      "texture_offset_x",
      "texture_offset_y",
      "texture_scale_x",
      "texture_scale_y",
      "variation_seed",
    ),
    unit,
  ),
  host_import("Render", "mesh", integer_record("id", "mesh"), unit),
  host_import(
    "Render",
    "node",
    record([
      ["id", integer],
      ["parent", integer],
      ["rotation_x_microradians", integer],
      ["rotation_y_microradians", integer],
      ["rotation_z_microradians", integer],
      ["scale_x", integer],
      ["scale_y", integer],
      ["scale_z", integer],
      ["visible", boolean],
      ["x", integer],
      ["y", integer],
      ["z", integer],
    ]),
    unit,
  ),
  host_import(
    "Render",
    "object",
    record([
      ["emissive", integer],
      ["id", integer],
      ["parent", integer],
      ["rotation_x_microradians", integer],
      ["rotation_y_microradians", integer],
      ["rotation_z_microradians", integer],
      ["scale_x", integer],
      ["scale_y", integer],
      ["scale_z", integer],
      ["visible", boolean],
      ["x", integer],
      ["y", integer],
      ["z", integer],
    ]),
    unit,
  ),
  host_import(
    "Render",
    "orthogonal_tilemap",
    integer_record(
      "atlas_columns",
      "cell_offset",
      "columns",
      "first_object_id",
      "mesh",
      "origin_x",
      "origin_y",
      "rows",
      "texture",
      "tile_size",
      "z",
    ),
    unit,
  ),
  host_import(
    "Render",
    "orthographic_camera",
    integer_record(
      "clear_blue",
      "clear_green",
      "clear_red",
      "position_x",
      "position_y",
      "position_z",
      "target_x",
      "target_y",
      "target_z",
      "vertical_size",
    ),
    unit,
  ),
  host_import(
    "Render",
    "perspective_camera",
    integer_record(
      "clear_blue",
      "clear_green",
      "clear_red",
      "position_x",
      "position_y",
      "position_z",
      "target_x",
      "target_y",
      "target_z",
      "vertical_fov_microradians",
    ),
    unit,
  ),
  host_import(
    "Resource",
    "mesh",
    record([
      ["asset", text],
      ["id", integer],
    ]),
    unit,
  ),
  host_import(
    "Resource",
    "texture",
    record([
      ["asset", text],
      ["id", integer],
    ]),
    unit,
  ),
  host_import("SceneTree", "enter", integer, integer),
  host_import("SceneTree", "leave", integer, unit),
  host_import(
    "Ui",
    "action",
    record([
      ["id", text],
      ["kind", integer],
      ["label", text],
      ["target", integer],
      ["value", integer],
    ]),
    unit,
  ),
  host_import(
    "Ui",
    "element",
    record([
      ["description", text],
      ["element_height", integer],
      ["element_width", integer],
      ["id", text],
      ["kind", integer],
      ["label", text],
      ["maximum", integer],
      ["order", integer],
      ["pressed", boolean],
      ["selected", boolean],
      ["target", integer],
      ["value", integer],
    ]),
    unit,
  ),
  host_import(
    "Ui",
    "placement",
    record([
      ["id", text],
      ["object", integer],
      ["offset_x", integer],
      ["offset_y", integer],
      ["offset_z", integer],
      ["plane_height", integer],
      ["plane_width", integer],
    ]),
    unit,
  ),
  host_import(
    "Ui",
    "status",
    record([
      ["done", boolean],
      ["label", text],
      ["value", text],
    ]),
    unit,
  ),
  host_import("State", "commit", integer, unit),
  host_import("State", "current", unit, integer),
  host_import("Time", "delta_us", unit, integer),
  host_import(
    "Viewport",
    "current",
    unit,
    integer_record("height", "width"),
  ),
] as const;

const protocol = {
  phases: {
    start: 0,
    update: 1,
    describe: 2,
    render: 3,
    schema: 4,
  },
  events: {
    elapsed: 0,
    focus: 1,
    activate: 2,
  },
  ui: {
    roles: {
      button: 0,
      text: 1,
      progress: 2,
    },
    viewport_anchors: {
      top_left: -1,
      top_right: -2,
      bottom_left: -3,
      bottom_right: -4,
      center: -5,
    },
  },
} as const;

const runtime_exports = [{
  sourceName: "default",
  name: "blot:default",
  phase: "runtime",
  function: { parameters: [], result: unit },
  postReturn: null,
  ownership: "owned",
}] as const;

export const blot_abi_registry = {
  format: "blot-core-wasm",
  policy: abi_policy,
  globals: {
    major: "blot:abi-major",
    minor: "blot:abi-minor",
  },
  protocol,
  runtime_exports,
  host_imports,
} as const;

type RegisteredHostImport = typeof host_imports[number];
type RegisteredCapability = RegisteredHostImport["capability"];

type BlotHostScalarValue<type extends BlotAbiType> = type extends
  { readonly kind: "unit" } ? undefined
  : type extends { readonly kind: "signed-integer-64" } ? bigint
  : type extends { readonly kind: "float-32" | "float-64" } ? number
  : type extends { readonly kind: "boolean" } ? boolean
  : type extends { readonly kind: "text" } ? string
  : never;

type BlotHostAbiValue<type extends BlotAbiType> = type extends {
  readonly kind: "record";
  readonly fields: infer fields extends readonly {
    readonly name: string;
    readonly type: BlotAbiType;
  }[];
} ? {
    readonly [field in fields[number] as field["name"]]: BlotHostScalarValue<
      field["type"]
    >;
  }
  : BlotHostScalarValue<type>;

type BlotHostImportArguments<declaration> = declaration extends {
  readonly function: {
    readonly parameters: readonly [infer parameter extends BlotAbiType];
  };
} ? parameter extends { readonly kind: "unit" } ? readonly []
  : readonly [parameter: BlotHostAbiValue<parameter>]
  : never;

type BlotHostImportResult<declaration> = declaration extends {
  readonly function: { readonly result: infer result extends BlotAbiType };
} ? result extends { readonly kind: "unit" } ? void
  : BlotHostAbiValue<result>
  : never;

type BlotHostImportImplementation<declaration> = (
  ...parameters: BlotHostImportArguments<declaration>
) => BlotHostImportResult<declaration>;

type BlotCapabilityImplementations<
  capability extends RegisteredCapability,
> = {
  readonly [
    declaration in Extract<
      RegisteredHostImport,
      { readonly capability: capability }
    > as declaration["operation"]
  ]: BlotHostImportImplementation<declaration>;
};

export type BlotHostImportImplementations = {
  readonly [capability in RegisteredCapability]: BlotCapabilityImplementations<
    capability
  >;
};

export interface BlotHostImportCodecBoundary {
  readonly memory: () => WebAssembly.Memory;
  readonly resolve_runtime_reference?: (reference: number) => unknown;
}

const registered_host_imports = new Map<string, BlotHostImportDeclaration>(
  host_imports.map((
    declaration,
  ) => [blot_host_import_key(declaration), declaration]),
);

export function blot_host_import_key(
  declaration: Pick<
    BlotHostImportDeclaration,
    "capability" | "operation"
  >,
): string {
  return `${declaration.capability}.${declaration.operation}`;
}

export function registered_blot_host_import(
  capability: string,
  operation: string,
): BlotHostImportDeclaration {
  const key = blot_host_import_key({ capability, operation });
  const declaration = registered_host_imports.get(key);
  if (declaration === undefined) {
    throw new Error(
      `Blot host import ${JSON.stringify(key)} is not registered`,
    );
  }
  return declaration;
}

export function create_blot_host_import_modules(
  implementations: BlotHostImportImplementations,
  boundary: BlotHostImportCodecBoundary,
): Record<string, Record<string, CallableFunction>> {
  const implemented = new Map<string, CallableFunction>();
  for (const [capability, operations] of Object.entries(implementations)) {
    for (const [operation, implementation] of Object.entries(operations)) {
      const key = blot_host_import_key({ capability, operation });
      if (implemented.has(key)) {
        throw new Error(`Blot host import ${JSON.stringify(key)} is repeated`);
      }
      if (typeof implementation !== "function") {
        throw new Error(
          `Blot host import ${JSON.stringify(key)} must be a function`,
        );
      }
      implemented.set(key, implementation);
    }
  }

  const expected = [...registered_host_imports.keys()].sort();
  const received = [...implemented.keys()].sort();
  if (expected.join("\n") !== received.join("\n")) {
    throw new Error(
      `Blot host imports ${JSON.stringify(received)} must equal ${
        JSON.stringify(expected)
      }`,
    );
  }

  const modules: Record<string, Record<string, CallableFunction>> = {};
  for (const declaration of host_imports) {
    const implementation = implemented.get(blot_host_import_key(declaration));
    if (implementation === undefined) {
      throw new Error(
        `registered Blot host import ${
          JSON.stringify(blot_host_import_key(declaration))
        } has no implementation`,
      );
    }
    const operations = modules[declaration.module] ?? {};
    operations[declaration.name] = create_host_import_codec(
      declaration,
      implementation,
      boundary,
    );
    modules[declaration.module] = operations;
  }
  return modules;
}

function create_host_import_codec(
  declaration: BlotHostImportDeclaration,
  implementation: CallableFunction,
  boundary: BlotHostImportCodecBoundary,
): CallableFunction {
  return (...wasm_values: unknown[]) => {
    const key = blot_host_import_key(declaration);
    const result_pointer = declaration.codec.result_passing === "indirect"
      ? take_result_pointer(wasm_values, key)
      : undefined;
    const parameter_values = result_pointer === undefined
      ? wasm_values
      : wasm_values.slice(0, -1);
    const parameter = decode_host_parameter(
      declaration,
      parameter_values,
      boundary,
    );
    const implementation_parameters =
      declaration.function.parameters[0]?.kind === "unit" ? [] : [parameter];
    const result = Reflect.apply(
      implementation,
      undefined,
      implementation_parameters,
    );
    const flat_result = encode_host_result(
      declaration.function.result,
      result,
      key,
    );
    if (declaration.codec.result_passing === "none") return undefined;
    if (declaration.codec.result_passing === "direct") {
      const direct_result = flat_result[0];
      if (direct_result === undefined) {
        throw new Error(
          `Blot host import ${JSON.stringify(key)} has no result`,
        );
      }
      return direct_result;
    }
    if (result_pointer === undefined) {
      throw new Error(
        `Blot host import ${JSON.stringify(key)} has no result pointer`,
      );
    }
    write_core_values(
      boundary.memory(),
      result_pointer,
      declaration.codec.flat_result,
      flat_result,
      `${key} result`,
    );
    return undefined;
  };
}

function take_result_pointer(
  wasm_values: readonly unknown[],
  key: string,
): number {
  const pointer = wasm_values.at(-1);
  if (!Number.isSafeInteger(pointer) || (pointer as number) < 0) {
    throw new Error(
      `Blot host import ${JSON.stringify(key)} result pointer ${
        String(pointer)
      } must be a non-negative safe integer`,
    );
  }
  return pointer as number;
}

function decode_host_parameter(
  declaration: BlotHostImportDeclaration,
  wasm_values: readonly unknown[],
  boundary: BlotHostImportCodecBoundary,
): unknown {
  const key = blot_host_import_key(declaration);
  const parameter = declaration.function.parameters[0];
  if (
    parameter === undefined || declaration.function.parameters.length !== 1
  ) {
    throw new Error(
      `Blot host import ${JSON.stringify(key)} must declare one parameter`,
    );
  }
  if (parameter.kind === "unit") {
    if (wasm_values.length !== 0) {
      throw new Error(
        `Blot host import ${
          JSON.stringify(key)
        } received ${wasm_values.length} parameter values; expected none`,
      );
    }
    return undefined;
  }

  const flat_values = host_parameter_core_values(
    declaration,
    wasm_values,
    boundary,
  );
  const cursor = { index: 0 };
  const decoded = decode_abi_value(
    parameter,
    flat_values,
    cursor,
    boundary.memory(),
    `${key} parameter`,
  );
  if (cursor.index !== flat_values.length) {
    throw new Error(
      `Blot host import ${
        JSON.stringify(key)
      } decoded ${cursor.index} of ${flat_values.length} parameter values`,
    );
  }
  return decoded;
}

function host_parameter_core_values(
  declaration: BlotHostImportDeclaration,
  wasm_values: readonly unknown[],
  boundary: BlotHostImportCodecBoundary,
): readonly (bigint | number)[] {
  const key = blot_host_import_key(declaration);
  if (declaration.codec.parameter_passing === "indirect") {
    const pointer = single_pointer(wasm_values, `${key} parameter`);
    return read_core_values(
      boundary.memory(),
      pointer,
      declaration.codec.flat_parameters,
      `${key} parameter`,
    );
  }

  let resolved_values = wasm_values;
  if (
    declaration.codec.flat_parameters.length > 1 &&
    wasm_values.length === 1 &&
    typeof wasm_values[0] === "number"
  ) {
    const reference = wasm_values[0];
    const resolve_runtime_reference = boundary.resolve_runtime_reference;
    if (resolve_runtime_reference !== undefined) {
      const runtime_value = resolve_runtime_reference(reference);
      if (runtime_value === undefined) {
        throw new Error(
          `Blot host import ${
            JSON.stringify(key)
          } runtime reference ${reference} is unknown or stale`,
        );
      }
      if (!Array.isArray(runtime_value)) {
        throw new Error(
          `Blot host import ${
            JSON.stringify(key)
          } runtime reference ${reference} must contain a product`,
        );
      }
      resolved_values = runtime_value;
    } else {
      return read_core_values(
        boundary.memory(),
        reference,
        declaration.codec.flat_parameters,
        `${key} parameter`,
      );
    }
  }
  return parse_core_values(
    resolved_values,
    declaration.codec.flat_parameters,
    `${key} parameter`,
  );
}

function single_pointer(values: readonly unknown[], label: string): number {
  const pointer = values[0];
  if (
    values.length !== 1 || !Number.isSafeInteger(pointer) ||
    (pointer as number) < 0
  ) {
    throw new Error(
      `Blot ${label} received ${values.length} values; expected one non-negative pointer`,
    );
  }
  return pointer as number;
}

function parse_core_values(
  values: readonly unknown[],
  types: readonly BlotCoreValue[],
  label: string,
): readonly (bigint | number)[] {
  if (values.length !== types.length) {
    throw new Error(
      `Blot ${label} received ${values.length} values; expected ${types.length}`,
    );
  }
  return values.map((value, index) => {
    const type = types[index];
    if (type === undefined) {
      throw new Error(`Blot ${label} value ${index} has no registered type`);
    }
    if (type === "i64") {
      if (typeof value !== "bigint") {
        throw new Error(
          `Blot ${label} value ${index} ${String(value)} must be i64`,
        );
      }
      return value;
    }
    if (typeof value !== "number") {
      throw new Error(
        `Blot ${label} value ${index} ${String(value)} must be ${type}`,
      );
    }
    return value;
  });
}

function decode_abi_value(
  type: BlotAbiType,
  values: readonly (bigint | number)[],
  cursor: { index: number },
  memory: WebAssembly.Memory,
  label: string,
): unknown {
  switch (type.kind) {
    case "unit":
      return undefined;
    case "signed-integer-64":
      return take_flat_value(values, cursor, "bigint", label);
    case "float-32":
    case "float-64":
      return take_flat_value(values, cursor, "number", label);
    case "boolean": {
      const value = take_flat_value(values, cursor, "number", label);
      if (value !== 0 && value !== 1) {
        throw new Error(
          `Blot ${label} boolean ${value} must be 0 or 1`,
        );
      }
      return value === 1;
    }
    case "text": {
      const pointer = take_flat_value(values, cursor, "number", label);
      const length = take_flat_value(values, cursor, "number", label);
      return read_guest_text(memory, pointer, length, label);
    }
    case "record": {
      const record_value: Record<string, unknown> = {};
      for (const field of type.fields) {
        record_value[field.name] = decode_abi_value(
          field.type,
          values,
          cursor,
          memory,
          `${label}.${field.name}`,
        );
      }
      return record_value;
    }
    case "sealed":
      return decode_abi_value(type.inner, values, cursor, memory, label);
    case "array":
    case "variant":
      throw new Error(
        `Blot ${label} uses unsupported host ABI type ${
          JSON.stringify(type.kind)
        }`,
      );
  }
}

function take_flat_value<kind extends "bigint" | "number">(
  values: readonly (bigint | number)[],
  cursor: { index: number },
  kind: kind,
  label: string,
): kind extends "bigint" ? bigint : number {
  const index = cursor.index;
  const value = values[index];
  if (kind === "bigint" && typeof value !== "bigint") {
    throw new Error(
      `Blot ${label} value ${index} ${String(value)} must be ${kind}`,
    );
  }
  if (kind === "number" && typeof value !== "number") {
    throw new Error(
      `Blot ${label} value ${index} ${String(value)} must be ${kind}`,
    );
  }
  cursor.index += 1;
  return value as kind extends "bigint" ? bigint : number;
}

function read_guest_text(
  memory: WebAssembly.Memory,
  pointer: number,
  length: number,
  label: string,
): string {
  const finish = pointer + length;
  if (
    !Number.isSafeInteger(pointer) || pointer < 0 ||
    !Number.isSafeInteger(length) || length < 0 ||
    !Number.isSafeInteger(finish) || finish > memory.buffer.byteLength
  ) {
    throw new Error(
      `Blot ${label} text range ${pointer}..${finish} is outside guest memory ${memory.buffer.byteLength}`,
    );
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    new Uint8Array(memory.buffer, pointer, length),
  );
}

function encode_host_result(
  type: BlotAbiType,
  value: unknown,
  label: string,
): readonly (bigint | number)[] {
  switch (type.kind) {
    case "unit":
      return [];
    case "signed-integer-64":
      if (typeof value !== "bigint") {
        throw new Error(`Blot ${label} result ${String(value)} must be i64`);
      }
      return [value];
    case "float-32":
    case "float-64":
      if (typeof value !== "number") {
        throw new Error(
          `Blot ${label} result ${String(value)} must be ${type.kind}`,
        );
      }
      return [value];
    case "boolean":
      if (typeof value !== "boolean") {
        throw new Error(
          `Blot ${label} result ${String(value)} must be boolean`,
        );
      }
      return [value ? 1 : 0];
    case "record": {
      if (typeof value !== "object" || value === null) {
        throw new Error(`Blot ${label} result must be a record`);
      }
      const flat_values: (bigint | number)[] = [];
      for (const field of type.fields) {
        flat_values.push(...encode_host_result(
          field.type,
          Reflect.get(value, field.name),
          `${label}.${field.name}`,
        ));
      }
      return flat_values;
    }
    case "sealed":
      return encode_host_result(type.inner, value, label);
    case "text":
    case "array":
    case "variant":
      throw new Error(
        `Blot ${label} uses unsupported host result type ${
          JSON.stringify(type.kind)
        }`,
      );
  }
}

function read_core_values(
  memory: WebAssembly.Memory,
  pointer: number,
  types: readonly BlotCoreValue[],
  label: string,
): readonly (bigint | number)[] {
  const layout = core_value_layout(pointer, types);
  require_memory_range(memory, pointer, layout.end, label);
  const view = new DataView(memory.buffer);
  return layout.values.map(({ offset, type }) => {
    switch (type) {
      case "i32":
        return view.getInt32(offset, true);
      case "i64":
        return view.getBigInt64(offset, true);
      case "f32":
        return view.getFloat32(offset, true);
      case "f64":
        return view.getFloat64(offset, true);
    }
  });
}

function write_core_values(
  memory: WebAssembly.Memory,
  pointer: number,
  types: readonly BlotCoreValue[],
  values: readonly (bigint | number)[],
  label: string,
): void {
  const parsed_values = parse_core_values(values, types, label);
  const layout = core_value_layout(pointer, types);
  require_memory_range(memory, pointer, layout.end, label);
  const view = new DataView(memory.buffer);
  for (const [index, { offset, type }] of layout.values.entries()) {
    const value = parsed_values[index];
    if (value === undefined) {
      throw new Error(`Blot ${label} value ${index} is missing`);
    }
    switch (type) {
      case "i32":
        view.setInt32(offset, value as number, true);
        break;
      case "i64":
        view.setBigInt64(offset, value as bigint, true);
        break;
      case "f32":
        view.setFloat32(offset, value as number, true);
        break;
      case "f64":
        view.setFloat64(offset, value as number, true);
        break;
    }
  }
}

function core_value_layout(
  pointer: number,
  types: readonly BlotCoreValue[],
): {
  readonly values: readonly {
    readonly offset: number;
    readonly type: BlotCoreValue;
  }[];
  readonly end: number;
} {
  let relative_offset = 0;
  const values = types.map((type) => {
    const width = type === "i32" || type === "f32" ? 4 : 8;
    relative_offset = Math.ceil(relative_offset / width) * width;
    const value = { offset: pointer + relative_offset, type };
    relative_offset += width;
    return value;
  });
  return { values, end: pointer + relative_offset };
}

function require_memory_range(
  memory: WebAssembly.Memory,
  start: number,
  end: number,
  label: string,
): void {
  if (
    !Number.isSafeInteger(start) || start < 0 ||
    !Number.isSafeInteger(end) || end < start || end > memory.buffer.byteLength
  ) {
    throw new Error(
      `Blot ${label} range ${start}..${end} is outside guest memory ${memory.buffer.byteLength}`,
    );
  }
}

export function require_blot_module_imports(
  module: WebAssembly.Module,
  declarations: readonly {
    readonly module: string;
    readonly name: string;
  }[],
): void {
  const expected = declarations.map((declaration) =>
    `${declaration.module}.${declaration.name}`
  ).sort();
  const received = WebAssembly.Module.imports(module)
    .filter((declaration) => declaration.module.startsWith("blot:host/"))
    .map((declaration) => `${declaration.module}.${declaration.name}`)
    .sort();
  if (received.join("\n") !== expected.join("\n")) {
    throw new Error(
      `Blot WebAssembly imports ${
        JSON.stringify(received)
      } must equal manifest imports ${JSON.stringify(expected)}`,
    );
  }
}

export interface BlotGuestAbiExports {
  readonly memory: WebAssembly.Memory;
  readonly reallocate: CallableFunction;
  readonly entrypoint: CallableFunction;
}

export function parse_blot_guest_exports(
  exports: WebAssembly.Exports,
): BlotGuestAbiExports {
  const memory_name = blot_abi_registry.policy.memoryExport;
  const memory = exports[memory_name];
  if (!(memory instanceof WebAssembly.Memory)) {
    throw new Error(
      `Blot guest export ${
        JSON.stringify(memory_name)
      } must be WebAssembly memory`,
    );
  }
  const realloc_name = blot_abi_registry.policy.reallocExport;
  const reallocate = exports[realloc_name];
  if (typeof reallocate !== "function") {
    throw new Error(
      `Blot guest export ${JSON.stringify(realloc_name)} must be a function`,
    );
  }
  const runtime_export = blot_abi_registry.runtime_exports[0];
  const entrypoint = exports[runtime_export.name];
  if (typeof entrypoint !== "function") {
    throw new Error(
      `Blot guest export ${
        JSON.stringify(runtime_export.name)
      } must be a function`,
    );
  }
  require_abi_global(
    exports,
    blot_abi_registry.globals.major,
    blot_abi_registry.policy.major,
  );
  require_abi_global(
    exports,
    blot_abi_registry.globals.minor,
    blot_abi_registry.policy.minor,
  );
  return { memory, reallocate, entrypoint };
}

function require_abi_global(
  exports: WebAssembly.Exports,
  name: string,
  expected: number,
): void {
  const global = exports[name];
  if (!(global instanceof WebAssembly.Global) || global.value !== expected) {
    throw new Error(
      `Blot guest export ${
        JSON.stringify(name)
      } must be a WebAssembly global with value ${expected}`,
    );
  }
}

export function blot_host_declarations_source(): string {
  const capabilities = new Map<string, BlotHostImportDeclaration[]>();
  for (const declaration of host_imports) {
    const operations = capabilities.get(declaration.capability) ?? [];
    operations.push(declaration);
    capabilities.set(declaration.capability, operations);
  }
  const declarations = [...capabilities.entries()].map(
    ([capability, operations]) => {
      const operation_sources = operations.map((declaration) => {
        const parameter = declaration.function.parameters[0];
        if (
          parameter === undefined ||
          declaration.function.parameters.length !== 1
        ) {
          throw new Error(
            `Blot host import ${
              JSON.stringify(blot_host_import_key(declaration))
            } must declare one source parameter`,
          );
        }
        return `  .${declaration.operation} = ${
          blot_type_source(parameter, 2)
        } -> ${blot_type_source(declaration.function.result, 2)};`;
      });
      return `const ${capability} = @effect.host {\n${
        operation_sources.join("\n")
      }\n}`;
    },
  );
  const exported = [...capabilities.keys()].map((capability) =>
    `  .${capability} = ${capability};`
  );
  return `// Generated by src/generate_abi.ts from blot_abi_registry.\nopen import "./prelude.blot"\n\n${
    declarations.join("\n\n")
  }\n\n${blot_protocol_declaration()}\n\nreturn {\n  .Protocol = Protocol;\n${
    exported.join("\n")
  }\n}\n`;
}

function blot_protocol_declaration(): string {
  const fields = (
    values: Readonly<Record<string, number>>,
    indentation: number,
  ): string => {
    const padding = " ".repeat(indentation);
    return `{\n${
      Object.entries(values).map(([name, value]) =>
        `${padding}  .${name} = ${value};`
      ).join("\n")
    }\n${padding}}`;
  };
  return `const Protocol = {
  .events = ${fields(protocol.events, 2)};
  .phases = ${fields(protocol.phases, 2)};
  .ui = {
    .roles = ${fields(protocol.ui.roles, 4)};
    .viewport_anchors = ${fields(protocol.ui.viewport_anchors, 4)};
  };
}`;
}

export function blot_abi_contract_source(): string {
  const calls = host_imports.map((declaration) => {
    const parameter = declaration.function.parameters[0];
    if (
      parameter === undefined || declaration.function.parameters.length !== 1
    ) {
      throw new Error(
        `Blot host import ${
          JSON.stringify(blot_host_import_key(declaration))
        } must declare one source parameter`,
      );
    }
    const invocation = `${declaration.capability}.${declaration.operation} ${
      blot_value_source(parameter)
    }`;
    if (declaration.function.result.kind === "unit") return `use ${invocation}`;
    const result_name = `${declaration.capability}_${declaration.operation}`
      .toLowerCase();
    return `use ${result_name} <- ${invocation}`;
  });
  return `// Generated by src/generate_abi.ts from blot_abi_registry.\nopen import "../prelude.blot"\nopen import "../abi.blot"\n\n${
    calls.join("\n")
  }\nreturn ()\n`;
}

function blot_type_source(type: BlotAbiType, indentation: number): string {
  switch (type.kind) {
    case "unit":
      return "Unit";
    case "signed-integer-64":
      return "Int";
    case "float-32":
      return "F32";
    case "float-64":
      return "F64";
    case "boolean":
      return "Bool";
    case "text":
      return "Text";
    case "array":
      return `[${blot_type_source(type.element, indentation)}]`;
    case "record": {
      const padding = " ".repeat(indentation);
      const fields = type.fields.map((field) =>
        `${padding}  .${field.name} = ${
          blot_type_source(field.type, indentation + 2)
        };`
      );
      return `{\n${fields.join("\n")}\n${padding}}`;
    }
    case "variant": {
      const cases = type.cases.map((variant_case) =>
        variant_case.payload === undefined
          ? `#${variant_case.name}`
          : `#${variant_case.name} ${
            blot_type_source(variant_case.payload, indentation)
          }`
      );
      return cases.join(" | ");
    }
    case "sealed":
      return `seal ${type.name} ${blot_type_source(type.inner, indentation)}`;
  }
}

function blot_value_source(type: BlotAbiType): string {
  switch (type.kind) {
    case "unit":
      return "()";
    case "signed-integer-64":
    case "float-32":
    case "float-64":
      return "0";
    case "boolean":
      return "False";
    case "text":
      return '""';
    case "record":
      return `{ ${
        type.fields.map((field) =>
          `.${field.name} = ${blot_value_source(field.type)};`
        ).join(" ")
      } }`;
    case "array":
      return "[]";
    case "variant":
    case "sealed":
      throw new Error(
        `Blot ABI contract generation does not support ${
          JSON.stringify(type.kind)
        } values`,
      );
  }
}
