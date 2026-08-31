import {
  type Effect,
  type Fails,
  from_either,
  Left,
  Program,
  Right,
  run,
  run_except,
} from "@mewhhaha/typeclasses";
import {
  blot_abi_registry,
  blot_host_import_key,
  type BlotAbiFunction,
  type BlotAbiType,
} from "./abi.ts";

export type BlotAbiPolicy = typeof blot_abi_registry.policy & {
  readonly requiredFeatures: readonly string[];
  readonly optimizationFeatures: readonly string[];
};

export interface BlotManifest {
  readonly format: typeof blot_abi_registry.format;
  readonly abi: BlotAbiPolicy;
  readonly source: string;
  readonly exports: readonly BlotExport[];
  readonly imports: readonly BlotImport[];
}

interface BlotExport {
  readonly sourceName: string;
  readonly name: string | null;
  readonly phase: "runtime" | "comptime";
  readonly function: BlotFunction | null;
  readonly postReturn: string | null;
  readonly effects: readonly string[];
  readonly ownership:
    | typeof blot_abi_registry.runtime_exports[number]["ownership"]
    | null;
}

interface BlotImport {
  readonly capability: string;
  readonly operation: string;
  readonly module: string;
  readonly name: string;
  readonly function: BlotFunction;
  readonly ownership:
    typeof blot_abi_registry.host_imports[number]["ownership"];
}

type BlotFunction = BlotAbiFunction;
type BlotType = BlotAbiType;

type ManifestParseFailure = readonly ["manifest.parse", string];
type ManifestParser<result> = Effect<Fails<ManifestParseFailure>, result>;

const Parse = Program.scope<Fails<ManifestParseFailure>>();

export function parse_blot_manifest(source: string): BlotManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    throw new Error("game manifest is not valid JSON", { cause });
  }

  const outcome = run(run_except(parse_manifest_value(parsed)));
  const [branch, value] = outcome.value();
  if (branch === "Left") throw new Error(value[1]);
  return value;
}

export function game_schema_source(
  manifest: BlotManifest,
  state_schema: string,
): string {
  return JSON.stringify({
    exports: manifest.exports.map((entry) => ({
      name: entry.sourceName,
      function: entry.function,
    })),
    imports: manifest.imports.map((entry) => ({
      capability: entry.capability,
      operation: entry.operation,
      function: entry.function,
    })),
    state_schema,
  });
}

function parse_manifest_value(value: unknown): ManifestParser<BlotManifest> {
  return Parse(function* () {
    const manifest = yield* expect_record(value, "game manifest");
    if (manifest.format !== blot_abi_registry.format) {
      return yield* reject(
        `game manifest format ${JSON.stringify(manifest.format)} must be ${
          JSON.stringify(blot_abi_registry.format)
        }`,
      );
    }
    const abi = yield* parse_abi_policy(manifest.abi);
    const source = yield* expect_string(
      manifest.source,
      "game manifest source",
    );
    const raw_exports = yield* expect_array(
      manifest.exports,
      "game manifest exports",
    );
    const exports: BlotExport[] = [];
    for (const [index, entry] of raw_exports.entries()) {
      exports.push(yield* parse_export(entry, index));
    }
    const raw_imports = yield* expect_array(
      manifest.imports,
      "game manifest imports",
    );
    const imports: BlotImport[] = [];
    for (const [index, entry] of raw_imports.entries()) {
      imports.push(yield* parse_import(entry, index));
    }

    const exported = exports
      .filter((entry) => entry.phase === "runtime")
      .map((entry) => entry.sourceName)
      .sort();
    const expected_exports = blot_abi_registry.runtime_exports
      .map((entry) => entry.sourceName)
      .sort();
    if (exported.join("\n") !== expected_exports.join("\n")) {
      return yield* reject(`game manifest exports ${JSON.stringify(exported)}`);
    }
    for (const expected of blot_abi_registry.runtime_exports) {
      const exported_entry = exports.find((entry) =>
        entry.phase === "runtime" && entry.sourceName === expected.sourceName
      );
      if (exported_entry === undefined) {
        return yield* reject(
          `game manifest omitted runtime export ${
            JSON.stringify(expected.sourceName)
          }`,
        );
      }
      if (
        exported_entry.name !== expected.name ||
        !same_structure(exported_entry.function, expected.function) ||
        exported_entry.postReturn !== expected.postReturn ||
        exported_entry.ownership !== expected.ownership
      ) {
        return yield* reject(
          `game manifest export ${
            JSON.stringify(expected.sourceName)
          } declaration ${JSON.stringify(exported_entry)} does not match ${
            JSON.stringify(expected)
          }`,
        );
      }
    }

    const imported = imports.map(blot_host_import_key).sort();
    if (new Set(imported).size !== imported.length) {
      return yield* reject(
        `game manifest has duplicate imports ${JSON.stringify(imported)}`,
      );
    }
    const wasm_imports = imports.map((entry) =>
      `${entry.module}.${entry.name}`
    );
    if (new Set(wasm_imports).size !== wasm_imports.length) {
      return yield* reject(
        `game manifest has duplicate WebAssembly imports ${
          JSON.stringify(wasm_imports.sort())
        }`,
      );
    }
    for (const imported_entry of imports) {
      const expected = blot_abi_registry.host_imports.find((entry) =>
        entry.capability === imported_entry.capability &&
        entry.operation === imported_entry.operation
      );
      if (expected === undefined) {
        return yield* reject(
          `game manifest has unsupported import ${
            JSON.stringify(blot_host_import_key(imported_entry))
          }`,
        );
      }
      if (
        imported_entry.module !== expected.module ||
        imported_entry.name !== expected.name ||
        !same_structure(imported_entry.function, expected.function) ||
        !same_structure(imported_entry.ownership, expected.ownership)
      ) {
        return yield* reject(
          `game manifest import ${
            JSON.stringify(blot_host_import_key(imported_entry))
          } declaration ${JSON.stringify(imported_entry)} does not match ${
            JSON.stringify(expected)
          }`,
        );
      }
    }
    const expected_effects = [
      ...new Set(imports.map((entry) => entry.capability)),
    ]
      .sort();
    for (const exported_entry of exports) {
      if (exported_entry.phase !== "runtime") continue;
      const effects = [...exported_entry.effects].sort();
      if (effects.join("\n") !== expected_effects.join("\n")) {
        return yield* reject(
          `game manifest export ${
            JSON.stringify(exported_entry.sourceName)
          } effects ${
            JSON.stringify(effects)
          } must equal imported capabilities ${
            JSON.stringify(expected_effects)
          }`,
        );
      }
    }
    return { format: blot_abi_registry.format, abi, source, exports, imports };
  });
}

function parse_abi_policy(value: unknown): ManifestParser<BlotAbiPolicy> {
  return Parse(function* () {
    const path = "game manifest ABI";
    const abi = yield* expect_record(value, path);
    const literal_keys = [
      "major",
      "minor",
      "coreSpecification",
      "memory",
      "stringEncoding",
      "maximumFlatParameters",
      "maximumFlatResults",
      "memoryExport",
      "reallocExport",
    ] as const;
    for (const key of literal_keys) {
      const expected = blot_abi_registry.policy[key];
      if (abi[key] !== expected) {
        return yield* reject(
          `${path}.${key} ${JSON.stringify(abi[key])} must be ${
            JSON.stringify(expected)
          }`,
        );
      }
    }
    const required_features = yield* parse_feature_list(
      abi.requiredFeatures,
      `${path}.requiredFeatures`,
    );
    const optimization_features = yield* parse_feature_list(
      abi.optimizationFeatures,
      `${path}.optimizationFeatures`,
    );
    return {
      ...blot_abi_registry.policy,
      requiredFeatures: required_features,
      optimizationFeatures: optimization_features,
    };
  });
}

function parse_feature_list(
  value: unknown,
  path: string,
): ManifestParser<readonly string[]> {
  return Parse(function* () {
    const raw_features = yield* expect_array(value, path);
    const features: string[] = [];
    for (const [index, feature] of raw_features.entries()) {
      features.push(yield* expect_string(feature, `${path}[${index}]`));
    }
    const canonical = [...new Set(features)].sort();
    if (features.join("\n") !== canonical.join("\n")) {
      return yield* reject(
        `${path} ${JSON.stringify(features)} must be sorted and unique`,
      );
    }
    return features;
  });
}

function same_structure(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parse_export(
  value: unknown,
  index: number,
): ManifestParser<BlotExport> {
  const path = `game manifest exports[${index}]`;
  return Parse(function* () {
    const entry = yield* expect_record(value, path);
    const phase = yield* expect_string(entry.phase, `${path}.phase`);
    if (phase !== "runtime" && phase !== "comptime") {
      return yield* reject(
        `${path}.phase ${
          JSON.stringify(phase)
        } must be "runtime" or "comptime"`,
      );
    }
    const name = entry.name === null
      ? null
      : yield* expect_string(entry.name, `${path}.name`);
    const fn = entry.function === null
      ? null
      : yield* parse_function(entry.function, `${path}.function`);
    const raw_effects = yield* expect_array(entry.effects, `${path}.effects`);
    const effects: string[] = [];
    for (const [index, effect] of raw_effects.entries()) {
      effects.push(yield* expect_string(effect, `${path}.effects[${index}]`));
    }
    const post_return = entry.postReturn === null
      ? null
      : yield* expect_string(entry.postReturn, `${path}.postReturn`);
    if (entry.ownership !== null && entry.ownership !== "owned") {
      return yield* reject(
        `${path}.ownership ${
          JSON.stringify(entry.ownership)
        } must be "owned" or null`,
      );
    }
    return {
      sourceName: yield* expect_string(
        entry.sourceName,
        `${path}.sourceName`,
      ),
      name,
      phase,
      function: fn,
      postReturn: post_return,
      effects,
      ownership: entry.ownership,
    };
  });
}

function parse_import(
  value: unknown,
  index: number,
): ManifestParser<BlotImport> {
  const path = `game manifest imports[${index}]`;
  return Parse(function* () {
    const entry = yield* expect_record(value, path);
    const ownership = yield* expect_record(
      entry.ownership,
      `${path}.ownership`,
    );
    if (
      ownership.input !== "unrestricted" ||
      ownership.result !== "unrestricted"
    ) {
      return yield* reject(
        `${path}.ownership ${
          JSON.stringify(ownership)
        } must have unrestricted input and result`,
      );
    }
    return {
      capability: yield* expect_string(
        entry.capability,
        `${path}.capability`,
      ),
      operation: yield* expect_string(entry.operation, `${path}.operation`),
      module: yield* expect_string(entry.module, `${path}.module`),
      name: yield* expect_string(entry.name, `${path}.name`),
      function: yield* parse_function(entry.function, `${path}.function`),
      ownership: { input: "unrestricted", result: "unrestricted" },
    };
  });
}

function parse_function(
  value: unknown,
  path: string,
): ManifestParser<BlotFunction> {
  return Parse(function* () {
    const fn = yield* expect_record(value, path);
    const raw_parameters = yield* expect_array(
      fn.parameters,
      `${path}.parameters`,
    );
    const parameters: BlotType[] = [];
    for (const [index, parameter] of raw_parameters.entries()) {
      parameters.push(
        yield* parse_type(parameter, `${path}.parameters[${index}]`),
      );
    }
    return {
      parameters,
      result: yield* parse_type(fn.result, `${path}.result`),
    };
  });
}

function parse_type(value: unknown, path: string): ManifestParser<BlotType> {
  return Parse(function* () {
    const type = yield* expect_record(value, path);
    const kind = yield* expect_string(type.kind, `${path}.kind`);
    switch (kind) {
      case "unit":
      case "signed-integer-64":
      case "float-32":
      case "float-64":
      case "boolean":
      case "text":
        return { kind };
      case "array":
        return {
          kind,
          element: yield* parse_type(type.element, `${path}.element`),
        };
      case "record": {
        const raw_fields = yield* expect_array(type.fields, `${path}.fields`);
        const fields: { readonly name: string; readonly type: BlotType }[] = [];
        for (const [index, raw_field] of raw_fields.entries()) {
          const field_path = `${path}.fields[${index}]`;
          const field = yield* expect_record(raw_field, field_path);
          fields.push({
            name: yield* expect_string(field.name, `${field_path}.name`),
            type: yield* parse_type(field.type, `${field_path}.type`),
          });
        }
        return { kind, fields };
      }
      case "variant": {
        const raw_cases = yield* expect_array(type.cases, `${path}.cases`);
        const cases: { readonly name: string; readonly payload?: BlotType }[] =
          [];
        for (const [index, raw_case] of raw_cases.entries()) {
          const case_path = `${path}.cases[${index}]`;
          const current = yield* expect_record(raw_case, case_path);
          const name = yield* expect_string(current.name, `${case_path}.name`);
          if (Object.hasOwn(current, "payload")) {
            cases.push({
              name,
              payload: yield* parse_type(
                current.payload,
                `${case_path}.payload`,
              ),
            });
          } else {
            cases.push({ name });
          }
        }
        return { kind, cases };
      }
      case "sealed":
        return {
          kind,
          name: yield* expect_string(type.name, `${path}.name`),
          inner: yield* parse_type(type.inner, `${path}.inner`),
        };
      default:
        return yield* reject(
          `${path}.kind ${JSON.stringify(kind)} is not supported`,
        );
    }
  });
}

function expect_record(
  value: unknown,
  path: string,
): ManifestParser<Record<string, unknown>> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return accept(value as Record<string, unknown>);
  }
  return reject(`${path} ${JSON.stringify(value)} must be an object`);
}

function expect_array(
  value: unknown,
  path: string,
): ManifestParser<readonly unknown[]> {
  return Array.isArray(value)
    ? accept(value)
    : reject(`${path} ${JSON.stringify(value)} must be an array`);
}

function expect_string(value: unknown, path: string): ManifestParser<string> {
  return typeof value === "string"
    ? accept(value)
    : reject(`${path} ${JSON.stringify(value)} must be a string`);
}

function accept<result>(value: result): ManifestParser<result> {
  return from_either(Right<ManifestParseFailure, result>(value));
}

function reject<result = never>(message: string): ManifestParser<result> {
  const failure: ManifestParseFailure = ["manifest.parse", message];
  return from_either(Left<ManifestParseFailure, result>(failure));
}
