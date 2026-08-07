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

export interface BlotManifest {
  readonly format: "blot-core-wasm";
  readonly source: string;
  readonly exports: readonly BlotExport[];
  readonly imports: readonly BlotImport[];
}

interface BlotExport {
  readonly sourceName: string;
  readonly name: string | null;
  readonly phase: "runtime" | "comptime";
  readonly function: BlotFunction | null;
}

interface BlotImport {
  readonly capability: string;
  readonly operation: string;
  readonly module: string;
  readonly name: string;
  readonly function: BlotFunction;
}

interface BlotFunction {
  readonly parameters: readonly BlotType[];
  readonly result: BlotType;
}

type BlotType =
  | { readonly kind: "unit" }
  | { readonly kind: "signed-integer-64" }
  | { readonly kind: "float-32" }
  | { readonly kind: "float-64" }
  | { readonly kind: "boolean" }
  | { readonly kind: "text" }
  | { readonly kind: "array"; readonly element: BlotType }
  | {
    readonly kind: "record";
    readonly fields: readonly {
      readonly name: string;
      readonly type: BlotType;
    }[];
  }
  | {
    readonly kind: "variant";
    readonly cases: readonly {
      readonly name: string;
      readonly payload?: BlotType;
    }[];
  }
  | {
    readonly kind: "sealed";
    readonly name: string;
    readonly inner: BlotType;
  };

type ManifestParseFailure = readonly ["manifest.parse", string];
type ManifestParser<result> = Effect<Fails<ManifestParseFailure>, result>;

const Parse = Program.scope<Fails<ManifestParseFailure>>();
const expected_exports = ["default"];
const supported_imports = new Set([
  "blot:host/Cells.get",
  "blot:host/Cells.put",
  "blot:host/DataAsset.get",
  "blot:host/DataAsset.length",
  "blot:host/DataAsset.copy_to_cells",
  "blot:host/EcsSchema.component",
  "blot:host/EcsSchema.resource",
  "blot:host/EcsSchema.seed_indexed",
  "blot:host/EcsSchema.world",
  "blot:host/Events.next",
  "blot:host/Phase.current",
  "blot:host/Resource.mesh",
  "blot:host/Resource.texture",
  "blot:host/Render.directional_light",
  "blot:host/Render.isometric_component_layer",
  "blot:host/Render.isometric_tilemap",
  "blot:host/Render.material",
  "blot:host/Render.mesh",
  "blot:host/Render.node",
  "blot:host/Render.object",
  "blot:host/Render.orthogonal_tilemap",
  "blot:host/Render.projection",
  "blot:host/Render.zoom",
  "blot:host/SceneTree.enter",
  "blot:host/SceneTree.leave",
  "blot:host/Semantic.action",
  "blot:host/Semantic.element",
  "blot:host/Semantic.placement",
  "blot:host/Semantic.status",
  "blot:host/Semantic.style",
  "blot:host/State.commit",
  "blot:host/State.current",
  "blot:host/Time.delta_us",
  "blot:host/Viewport.current",
]);

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
    if (manifest.format !== "blot-core-wasm") {
      return yield* reject(
        `game manifest format ${
          JSON.stringify(manifest.format)
        } must be "blot-core-wasm"`,
      );
    }
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
    if (exported.join("\n") !== [...expected_exports].sort().join("\n")) {
      return yield* reject(`game manifest exports ${JSON.stringify(exported)}`);
    }
    const imported = imports
      .map((entry) => `${entry.module}.${entry.name}`)
      .sort();
    const unique_imports = new Set(imported);
    if (unique_imports.size !== imported.length) {
      return yield* reject(
        `game manifest has duplicate imports ${JSON.stringify(imported)}`,
      );
    }
    const unsupported = imported.filter((entry) =>
      !supported_imports.has(entry)
    );
    if (unsupported.length > 0) {
      return yield* reject(
        `game manifest has unsupported imports ${JSON.stringify(unsupported)}`,
      );
    }
    return { format: "blot-core-wasm", source, exports, imports };
  });
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
    return {
      sourceName: yield* expect_string(
        entry.sourceName,
        `${path}.sourceName`,
      ),
      name,
      phase,
      function: fn,
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
    return {
      capability: yield* expect_string(
        entry.capability,
        `${path}.capability`,
      ),
      operation: yield* expect_string(entry.operation, `${path}.operation`),
      module: yield* expect_string(entry.module, `${path}.module`),
      name: yield* expect_string(entry.name, `${path}.name`),
      function: yield* parse_function(entry.function, `${path}.function`),
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
