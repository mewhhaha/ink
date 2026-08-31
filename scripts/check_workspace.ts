import {
  dirname,
  isAbsolute,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  ink_project_kind,
  type InkProjectKind,
} from "./workspace/sync_workspace_manifests.ts";
import {
  parse_scenario_assertion_report,
  scenario_report_environment,
} from "./scenario_report.ts";

const workspace_directory = fileURLToPath(new URL("../", import.meta.url));
const project_roots = ["apps", "editors", "packages"];
const source_extensions = [".blot", ".js", ".mjs", ".ts", ".tsx"];
const dependency_fields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;
const application_entrypoint_script_categories: readonly string[] = [
  "build",
  "dev",
  "headless",
  "postbuild",
  "prebuild",
  "prepare",
  "scenario",
  "start",
];
const regular_expression_prefix_keywords: readonly string[] = [
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
];

interface InkProject {
  readonly directory: string;
  readonly entrypoint_paths: readonly string[];
  readonly exports: ReadonlyMap<string, readonly string[]>;
  readonly internal_dependencies: ReadonlySet<string>;
  readonly kind: InkProjectKind;
  readonly name: string;
  readonly path: string;
  readonly source_files: readonly SourceFile[];
}

interface SourceFile {
  readonly absolute_path: string;
  readonly imports: readonly string[];
  readonly path: string;
  readonly production: boolean;
  readonly runtime_imports: readonly string[];
  readonly source: string;
}

export interface ScenarioCommands {
  readonly browser: string;
  readonly headless: string;
}

export type ScenarioCommandKind = keyof ScenarioCommands;
export type ScenarioAssertionId = `${ScenarioCommandKind}:${string}`;

export interface ScenarioProof {
  readonly package: string;
  readonly exports: readonly string[];
  readonly assertions: readonly ScenarioAssertionId[];
}

interface ScenarioBase {
  readonly commands: ScenarioCommands;
  readonly edit: string;
  readonly expected_outcome: string;
  readonly proofs: readonly ScenarioProof[];
  readonly version: 2;
}

export interface EditorGameScenario extends ScenarioBase {
  readonly role: "editor_game";
  readonly editor: string;
}

export interface CapabilityDemoScenario extends ScenarioBase {
  readonly role: "capability_demo";
}

export type ApplicationScenario = EditorGameScenario | CapabilityDemoScenario;

export interface ScenarioCommandRequest {
  readonly command: string;
  readonly kind: ScenarioCommandKind;
  readonly report_path: string;
  readonly working_directory: string;
}

export interface ScenarioCommandResult {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

export type ScenarioCommandExecutor = (
  request: ScenarioCommandRequest,
) => Promise<ScenarioCommandResult>;

export interface ScenarioReportBoundary {
  create_path(kind: ScenarioCommandKind): Promise<string>;
  read(path: string): Promise<string>;
  remove(path: string): Promise<void>;
}

export interface RunScenarioCommandsOptions {
  readonly execute?: ScenarioCommandExecutor;
  readonly reports?: ScenarioReportBoundary;
  readonly scenario: ApplicationScenario;
  readonly scenario_path: string;
  readonly working_directory: string;
}

export interface WorkspaceCheckOptions {
  readonly execute_scenario_command?: ScenarioCommandExecutor;
  readonly reports?: ScenarioReportBoundary;
  readonly root?: string;
}

export interface ApplicationProofResult {
  readonly editor_wiring: "invalid" | "valid";
  readonly scenario: ApplicationScenario;
  readonly validated_exports: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface ScenarioCoverage {
  readonly owner_violations: readonly string[];
  readonly proven_exports: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface WorkspaceProofExport {
  readonly specifier: string;
  readonly subpath: string;
  readonly stability: "experimental" | "stable";
  readonly targets: readonly string[];
}

export interface WorkspaceProofPackage {
  readonly exports: readonly WorkspaceProofExport[];
  readonly kind: InkProjectKind;
  readonly name: string;
  readonly path: string;
}

export interface WorkspaceProofScenario {
  readonly application: string;
  readonly path: string;
  readonly scenario: ApplicationScenario;
}

export interface WorkspaceProofReport {
  readonly version: 1;
  readonly packages: readonly WorkspaceProofPackage[];
  readonly scenarios: readonly WorkspaceProofScenario[];
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse_json_object(
  source: string,
  path: string,
): Record<string, unknown> {
  let parsed_value: unknown;
  try {
    parsed_value = JSON.parse(source);
  } catch (error) {
    throw new Error(`cannot parse ${path}: ${error}`);
  }
  if (!is_record(parsed_value)) {
    throw new Error(`${path} must contain an object`);
  }
  return parsed_value;
}

function required_string(
  record: Record<string, unknown>,
  field: string,
  path: string,
): string {
  const value = record[field];
  if (
    typeof value !== "string" || value.length === 0 || value.trim() !== value
  ) {
    throw new Error(
      `${path} field ${field} ${
        JSON.stringify(value)
      } must be a non-empty string without surrounding whitespace`,
    );
  }
  return value;
}

function string_array(
  record: Record<string, unknown>,
  field: string,
  path: string,
  options: { readonly minimum_length?: number } = {},
): readonly string[] {
  const value = record[field];
  if (
    !Array.isArray(value) ||
    value.some((element) =>
      typeof element !== "string" || element.length === 0 ||
      element.trim() !== element
    )
  ) {
    throw new Error(
      `${path} field ${field} must be an array of non-empty strings without surrounding whitespace`,
    );
  }
  if (value.length < (options.minimum_length ?? 0)) {
    throw new Error(
      `${path} field ${field} must contain at least ${options.minimum_length} entries`,
    );
  }
  return Object.freeze([...value]);
}

function expect_fields(
  record: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const actual = Object.keys(record).sort();
  const sorted_expected = [...expected].sort();
  if (
    actual.length === sorted_expected.length &&
    actual.every((field, index) => field === sorted_expected[index])
  ) {
    return;
  }
  throw new Error(
    `${path} fields ${JSON.stringify(actual)} must be ${
      JSON.stringify(sorted_expected)
    }`,
  );
}

function parse_kind(value: unknown, path: string): InkProjectKind {
  if (
    value === "core" || value === "adapter" || value === "editor" ||
    value === "application"
  ) {
    return value;
  }
  throw new Error(
    `${path} ink.kind must be core, adapter, editor, or application`,
  );
}

export function parse_application_scenario(
  source: string,
  path: string,
): ApplicationScenario {
  const record = parse_json_object(source, path);
  if (record.version !== 2) {
    throw new Error(
      `${path} version ${JSON.stringify(record.version)} must be 2`,
    );
  }
  const role = record.role;
  const common_fields = [
    "commands",
    "edit",
    "expected_outcome",
    "proofs",
    "role",
    "version",
  ];
  if (role === "editor_game") {
    expect_fields(record, [...common_fields, "editor"], path);
  } else if (role === "capability_demo") {
    expect_fields(record, common_fields, path);
  } else {
    throw new Error(
      `${path} role ${
        JSON.stringify(role)
      } must be "editor_game" or "capability_demo"`,
    );
  }

  const commands = parse_scenario_commands(record.commands, `${path} commands`);
  const proofs = parse_scenario_proofs(record.proofs, `${path} proofs`);
  const common = {
    version: 2 as const,
    role,
    commands,
    proofs,
    edit: required_string(record, "edit", path),
    expected_outcome: required_string(record, "expected_outcome", path),
  };
  if (role === "editor_game") {
    return Object.freeze({
      ...common,
      role,
      editor: required_string(record, "editor", path),
    });
  }
  return Object.freeze({ ...common, role });
}

function parse_scenario_commands(
  value: unknown,
  path: string,
): ScenarioCommands {
  if (!is_record(value)) throw new Error(`${path} must contain an object`);
  expect_fields(value, ["browser", "headless"], path);
  return Object.freeze({
    browser: required_string(value, "browser", path),
    headless: required_string(value, "headless", path),
  });
}

function parse_scenario_proofs(
  value: unknown,
  path: string,
): readonly ScenarioProof[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return Object.freeze(value.map((entry, index) => {
    const proof_path = `${path}[${index}]`;
    if (!is_record(entry)) {
      throw new Error(`${proof_path} must contain an object`);
    }
    expect_fields(entry, ["assertions", "exports", "package"], proof_path);
    const exports = unique_string_array(
      entry,
      "exports",
      proof_path,
      { minimum_length: 1 },
    );
    for (const subpath of exports) {
      if (
        subpath !== "." &&
        (!subpath.startsWith("./") || subpath.includes("*"))
      ) {
        throw new Error(
          `${proof_path} export ${
            JSON.stringify(subpath)
          } must be "." or a concrete package subpath beginning with "./"`,
        );
      }
    }
    const assertions = unique_string_array(
      entry,
      "assertions",
      proof_path,
      { minimum_length: 1 },
    ).map((assertion, assertion_index) =>
      parse_scenario_assertion_id(
        assertion,
        `${proof_path} assertions[${assertion_index}]`,
      )
    );
    return Object.freeze({
      package: required_string(entry, "package", proof_path),
      exports,
      assertions: Object.freeze(assertions),
    });
  }));
}

function is_scenario_assertion_id(
  value: string,
): value is ScenarioAssertionId {
  return value.startsWith("browser:") && value.length > "browser:".length ||
    value.startsWith("headless:") && value.length > "headless:".length;
}

function parse_scenario_assertion_id(
  value: string,
  path: string,
): ScenarioAssertionId {
  if (is_scenario_assertion_id(value)) return value;
  throw new Error(
    `${path} ${
      JSON.stringify(value)
    } must begin with "browser:" or "headless:" and name an assertion`,
  );
}

function scenario_assertion_kind(
  value: ScenarioAssertionId,
): ScenarioCommandKind;
function scenario_assertion_kind(
  value: string,
): ScenarioCommandKind | undefined;
function scenario_assertion_kind(
  value: string,
): ScenarioCommandKind | undefined {
  if (value.startsWith("browser:")) return "browser";
  if (value.startsWith("headless:")) return "headless";
  return undefined;
}

function unique_string_array(
  record: Record<string, unknown>,
  field: string,
  path: string,
  options: { readonly minimum_length?: number } = {},
): readonly string[] {
  const values = string_array(record, field, path, options);
  if (new Set(values).size !== values.length) {
    throw new Error(`${path} field ${field} must not contain duplicates`);
  }
  return values;
}

const default_scenario_reports: ScenarioReportBoundary = {
  async create_path(kind) {
    const directory = await Deno.makeTempDir({
      prefix: `ink-scenario-${kind}-`,
    });
    return resolve(directory, "assertions.json");
  },
  read: (path) => Deno.readTextFile(path),
  remove: (path) => Deno.remove(dirname(path), { recursive: true }),
};

export const execute_scenario_command: ScenarioCommandExecutor = async (
  request,
) => {
  const windows = Deno.build.os === "windows";
  const executable = windows ? "cmd.exe" : "/bin/sh";
  const arguments_ = windows
    ? ["/d", "/s", "/c", request.command]
    : ["-c", request.command];
  const output = await new Deno.Command(executable, {
    args: arguments_,
    cwd: request.working_directory,
    env: { [scenario_report_environment]: request.report_path },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
};

export async function run_scenario_commands(
  options: RunScenarioCommandsOptions,
): Promise<ReadonlySet<string>> {
  const execute = options.execute ?? execute_scenario_command;
  const reports = options.reports ?? default_scenario_reports;
  const declared_by_kind: Record<
    ScenarioCommandKind,
    Set<string>
  > = {
    browser: new Set(),
    headless: new Set(),
  };
  for (
    const assertion of options.scenario.proofs.flatMap((proof) =>
      proof.assertions
    )
  ) {
    declared_by_kind[scenario_assertion_kind(assertion)].add(assertion);
  }
  const declared = new Set([
    ...declared_by_kind.browser,
    ...declared_by_kind.headless,
  ]);
  const passed = new Set<string>();
  const report_paths = new Set<string>();

  for (const kind of ["headless", "browser"] as const) {
    const report_path = await reports.create_path(kind);
    let scenario_failed = false;
    let scenario_failure: unknown;
    try {
      if (report_paths.has(report_path)) {
        throw new Error(
          `${options.scenario_path} ${kind} command reused scenario report path ${
            JSON.stringify(report_path)
          }`,
        );
      }
      report_paths.add(report_path);
      const command = options.scenario.commands[kind];
      let result: ScenarioCommandResult;
      try {
        result = await execute({
          command,
          kind,
          report_path,
          working_directory: options.working_directory,
        });
      } catch (cause) {
        throw new Error(
          `${options.scenario_path} ${kind} command ${
            JSON.stringify(command)
          } could not start`,
          { cause },
        );
      }
      if (result.code !== 0) {
        const evidence = result.stderr.trim() || result.stdout.trim() ||
          "no command output";
        throw new Error(
          `${options.scenario_path} ${kind} command ${
            JSON.stringify(command)
          } exited with code ${result.code}: ${evidence}`,
        );
      }

      let report_source: string;
      try {
        report_source = await reports.read(report_path);
      } catch (cause) {
        throw new Error(
          `${options.scenario_path} ${kind} command ${
            JSON.stringify(command)
          } did not write ${scenario_report_environment} report ${
            JSON.stringify(report_path)
          }`,
          { cause },
        );
      }
      let report;
      try {
        report = parse_scenario_assertion_report(report_source, report_path);
      } catch (cause) {
        throw new Error(
          `${options.scenario_path} ${kind} command wrote an invalid scenario assertion report ${
            JSON.stringify(report_path)
          }`,
          { cause },
        );
      }
      for (const assertion of report.assertions) {
        const reported_kind = scenario_assertion_kind(assertion.id);
        if (reported_kind !== kind) {
          throw new Error(
            `${options.scenario_path} ${kind} command reported ${
              reported_kind ?? "unowned"
            } assertion ${JSON.stringify(assertion.id)}`,
          );
        }
        if (!declared_by_kind[kind].has(assertion.id)) {
          throw new Error(
            `${options.scenario_path} ${kind} command reported unknown assertion ${
              JSON.stringify(assertion.id)
            }`,
          );
        }
        if (passed.has(assertion.id)) {
          throw new Error(
            `${options.scenario_path} commands reported assertion ${
              JSON.stringify(assertion.id)
            } more than once`,
          );
        }
        if (assertion.status === "failed") {
          throw new Error(
            `${options.scenario_path} ${kind} assertion ${
              JSON.stringify(assertion.id)
            } failed: ${assertion.reason}`,
          );
        }
        passed.add(assertion.id);
      }
    } catch (error) {
      scenario_failed = true;
      scenario_failure = error;
    }
    try {
      await reports.remove(report_path);
    } catch (cleanup_failure) {
      if (scenario_failed) {
        throw new AggregateError(
          [scenario_failure, cleanup_failure],
          `${options.scenario_path} ${kind} command failed and could not remove scenario report ${
            JSON.stringify(report_path)
          }`,
        );
      }
      throw new Error(
        `${options.scenario_path} ${kind} command could not remove scenario report ${
          JSON.stringify(report_path)
        }`,
        { cause: cleanup_failure },
      );
    }
    if (scenario_failed) throw scenario_failure;
  }

  const missing = [...declared].filter((id) => !passed.has(id)).sort();
  if (missing.length > 0) {
    throw new Error(
      `${options.scenario_path} commands did not report assertions ${
        JSON.stringify(missing)
      }`,
    );
  }
  return passed;
}

type SourceToken =
  | { readonly kind: "identifier"; readonly value: string }
  | { readonly kind: "punctuation"; readonly value: string }
  | { readonly kind: "string"; readonly value: string };

type SourceImport =
  | { readonly kind: "runtime"; readonly specifier: string }
  | { readonly kind: "type_only"; readonly specifier: string };

function source_tokens(source: string): readonly SourceToken[] {
  const tokens: SourceToken[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === undefined) break;
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index + 2);
      if (index === -1) break;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      const comment_end = source.indexOf("*/", index + 2);
      if (comment_end === -1) break;
      index = comment_end + 2;
      continue;
    }
    if (character === "/") {
      const previous = tokens.at(-1);
      const follows_expression_prefix = previous === undefined ||
        previous.kind === "punctuation" &&
          "([{,;:=!?&|+-*%^~<>".includes(previous.value) ||
        previous.kind === "identifier" &&
          regular_expression_prefix_keywords.includes(previous.value);
      if (follows_expression_prefix) {
        let character_class = false;
        index += 1;
        while (index < source.length) {
          const regular_expression_character = source[index];
          if (regular_expression_character === undefined) break;
          if (regular_expression_character === "\\") {
            index += 2;
            continue;
          }
          if (regular_expression_character === "[") character_class = true;
          else if (regular_expression_character === "]") {
            character_class = false;
          } else if (regular_expression_character === "/" && !character_class) {
            index += 1;
            while (/[A-Za-z]/.test(source[index] ?? "")) index += 1;
            break;
          }
          index += 1;
        }
        continue;
      }
    }
    if (character === "`" || character === '"' || character === "'") {
      const quote = character;
      let value = "";
      index += 1;
      while (index < source.length) {
        const string_character = source[index];
        if (string_character === undefined) break;
        if (string_character === "\\") {
          const escaped_character = source[index + 1];
          if (escaped_character === undefined) {
            index += 1;
            break;
          }
          value += `\\${escaped_character}`;
          index += 2;
          continue;
        }
        index += 1;
        if (string_character === quote) break;
        value += string_character;
      }
      if (quote !== "`") tokens.push({ kind: "string", value });
      continue;
    }
    if (/[A-Za-z_$]/.test(character)) {
      const start = index;
      index += 1;
      while (/[A-Za-z0-9_$]/.test(source[index] ?? "")) index += 1;
      tokens.push({ kind: "identifier", value: source.slice(start, index) });
      continue;
    }
    tokens.push({ kind: "punctuation", value: character });
    index += 1;
  }
  return tokens;
}

function named_clause_has_runtime_binding(
  tokens: readonly SourceToken[],
): boolean {
  let group_start = 0;
  for (let index = 0; index <= tokens.length; index += 1) {
    const token = tokens[index];
    if (
      index < tokens.length &&
      !(token?.kind === "punctuation" && token.value === ",")
    ) {
      continue;
    }
    const group = tokens.slice(group_start, index);
    const first = group.find((candidate) =>
      candidate.kind === "identifier" || candidate.kind === "string"
    );
    if (
      first !== undefined &&
      !(first.kind === "identifier" && first.value === "type")
    ) {
      return true;
    }
    group_start = index + 1;
  }
  return false;
}

function module_clause_has_runtime_binding(
  tokens: readonly SourceToken[],
): boolean {
  const opening_brace = tokens.findIndex((token) =>
    token.kind === "punctuation" && token.value === "{"
  );
  if (opening_brace === -1) return tokens.length > 0;
  if (
    tokens.slice(0, opening_brace).some((token) =>
      token.kind === "identifier" && token.value !== "type"
    )
  ) {
    return true;
  }
  const closing_brace = tokens.findIndex((token, index) =>
    index > opening_brace && token.kind === "punctuation" && token.value === "}"
  );
  const clause_end = closing_brace === -1 ? tokens.length : closing_brace;
  return named_clause_has_runtime_binding(
    tokens.slice(opening_brace + 1, clause_end),
  );
}

function module_specifier_after(
  tokens: readonly SourceToken[],
  keyword_index: number,
): SourceImport | undefined {
  const keyword = tokens[keyword_index];
  const next = tokens[keyword_index + 1];
  if (keyword?.kind !== "identifier" || next === undefined) return undefined;
  const declaration_is_type_only = next.kind === "identifier" &&
    next.value === "type";
  if (keyword.value === "import" && next.kind === "string") {
    return { kind: "runtime", specifier: next.value };
  }
  if (
    keyword.value === "import" && next.kind === "punctuation" &&
    next.value === "(" && tokens[keyword_index + 2]?.kind === "string"
  ) {
    return {
      kind: "runtime",
      specifier: tokens[keyword_index + 2].value,
    };
  }

  let from_index = keyword_index + 1;
  while (from_index < tokens.length) {
    const token = tokens[from_index];
    if (token?.kind === "punctuation" && token.value === ";") {
      return undefined;
    }
    if (token?.kind === "identifier" && token.value === "from") break;
    from_index += 1;
  }
  if (from_index === tokens.length) return undefined;
  const specifier = tokens[from_index + 1];
  if (specifier?.kind !== "string") return undefined;
  const clause_start = declaration_is_type_only
    ? keyword_index + 2
    : keyword_index + 1;
  const clause_is_runtime = !declaration_is_type_only &&
    module_clause_has_runtime_binding(tokens.slice(clause_start, from_index));
  return {
    kind: clause_is_runtime ? "runtime" : "type_only",
    specifier: specifier.value,
  };
}

function source_import_edges(source: string): readonly SourceImport[] {
  const tokens = source_tokens(source);
  const imports = new Map<string, SourceImport>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (
      token?.kind !== "identifier" ||
      (token.value !== "import" && token.value !== "export")
    ) {
      continue;
    }
    const previous = tokens[index - 1];
    if (previous?.kind === "punctuation" && previous.value === ".") continue;
    const imported = module_specifier_after(tokens, index);
    if (imported === undefined) continue;
    const existing = imports.get(imported.specifier);
    if (existing?.kind === "runtime") continue;
    imports.set(imported.specifier, imported);
  }
  return [...imports.values()].sort((left, right) =>
    left.specifier.localeCompare(right.specifier)
  );
}

export function source_imports(source: string): readonly string[] {
  return source_import_edges(source).filter(({ kind }) => kind === "runtime")
    .map(({ specifier }) => specifier);
}

export function package_export_subpath(
  specifier: string,
  package_name: string,
): string | undefined {
  if (specifier === package_name) return ".";
  if (!specifier.startsWith(`${package_name}/`)) return undefined;
  return `.${specifier.slice(package_name.length)}`;
}

export function dependency_direction_allowed(
  source_kind: InkProjectKind,
  target_kind: InkProjectKind,
): boolean {
  if (source_kind === "application") return target_kind !== "application";
  return target_kind === "core";
}

export function collect_scenario_coverage(
  editors: readonly string[],
  applications: readonly ApplicationProofResult[],
): ScenarioCoverage {
  const owner_violations: string[] = [];
  for (const editor of editors) {
    const owner_count = applications.filter(({ scenario }) =>
      scenario.role === "editor_game" && scenario.editor === editor
    ).length;
    if (owner_count !== 1) {
      owner_violations.push(`editor.owner-count:${editor}=${owner_count}`);
    }
  }

  const proven_exports = new Map<string, Set<string>>();
  for (const application of applications) {
    if (
      application.scenario.role !== "editor_game" ||
      application.editor_wiring !== "valid"
    ) {
      continue;
    }
    for (
      const [package_name, subpaths] of application.validated_exports
    ) {
      const covered = proven_exports.get(package_name) ?? new Set<string>();
      for (const subpath of subpaths) covered.add(subpath);
      proven_exports.set(package_name, covered);
    }
  }
  return {
    owner_violations: owner_violations.sort(),
    proven_exports,
  };
}

function export_targets(value: unknown, path: string): readonly string[] {
  if (typeof value === "string") {
    if (
      value.length === 0 || value.trim() !== value || !value.startsWith("./")
    ) {
      throw new Error(
        `${path} target ${
          JSON.stringify(value)
        } must be a local path beginning with "./"`,
      );
    }
    return [value];
  }
  if (!is_record(value)) {
    throw new Error(
      `${path} exports must contain strings or condition objects`,
    );
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    throw new Error(`${path} export condition object cannot be empty`);
  }
  return entries.flatMap(([condition, target]) =>
    export_targets(target, `${path} condition ${JSON.stringify(condition)}`)
  );
}

export function parse_package_exports(
  value: unknown,
  path: string,
): ReadonlyMap<string, readonly string[]> {
  if (!is_record(value)) {
    throw new Error(`${path} exports must contain an object`);
  }
  const exports = new Map<string, readonly string[]>();
  for (const [subpath, target] of Object.entries(value)) {
    if (
      subpath.trim() !== subpath ||
      (subpath !== "." && !subpath.startsWith("./"))
    ) {
      throw new Error(
        `${path} export subpath ${
          JSON.stringify(subpath)
        } must be "." or begin with "./"`,
      );
    }
    exports.set(
      subpath,
      Object.freeze(export_targets(target, `${path} export ${subpath}`)),
    );
  }
  return exports;
}

function export_namespace_is_experimental(subpath: string): boolean {
  return subpath === "./experimental" ||
    subpath.startsWith("./experimental/");
}

function export_target_is_experimental(target: string): boolean {
  return normalize(target).replaceAll(sep, "/").startsWith(
    "src/experimental/",
  );
}

export function export_location_violations(
  package_name: string,
  exports: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  const violations: string[] = [];
  for (const [subpath, targets] of exports) {
    const namespace_is_experimental = export_namespace_is_experimental(
      subpath,
    );
    for (const target of targets) {
      const target_is_experimental = export_target_is_experimental(target);
      if (namespace_is_experimental === target_is_experimental) continue;
      const location = namespace_is_experimental
        ? "experimental-location"
        : "stable-location";
      const specifier = package_export_specifier(package_name, subpath);
      violations.push(
        `export.${location}:${specifier}->${target}`,
      );
    }
  }
  return violations.sort();
}

function package_name(specifier: string): string | undefined {
  if (
    specifier.startsWith(".") || specifier.startsWith("/") ||
    specifier.startsWith("node:") || specifier.startsWith("jsr:") ||
    specifier.startsWith("npm:") || specifier.includes("://")
  ) {
    return undefined;
  }
  const segments = specifier.split("/");
  if (specifier.startsWith("@")) {
    if (segments.length < 2) return undefined;
    return `${segments[0]}/${segments[1]}`;
  }
  return segments[0];
}

function path_is_within(parent: string, candidate: string): boolean {
  const remainder = relative(parent, candidate);
  return remainder === "" ||
    (!isAbsolute(remainder) && remainder !== ".." &&
      !remainder.startsWith(`..${sep}`));
}

function source_is_production(path: string): boolean {
  const filename = path.split("/").at(-1) ?? path;
  if (/_(?:bench|test)\.(?:js|mjs|ts|tsx)$/.test(filename)) return false;
  return !path.split("/").some((segment) =>
    segment === "fixtures" || segment === "test_fixtures"
  );
}

async function source_paths(directory: string): Promise<readonly string[]> {
  const paths: string[] = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    for await (const directory_entry of Deno.readDir(current)) {
      if (
        directory_entry.name === "dist" ||
        directory_entry.name === "node_modules" ||
        directory_entry.name === ".vite"
      ) {
        continue;
      }
      const child = resolve(current, directory_entry.name);
      if (directory_entry.isDirectory) {
        pending.push(child);
        continue;
      }
      if (
        directory_entry.isFile &&
        source_extensions.some((extension) => child.endsWith(extension))
      ) {
        paths.push(child);
      }
    }
  }
  return paths.sort();
}

async function read_source_files(
  directory: string,
): Promise<readonly SourceFile[]> {
  return await Promise.all((await source_paths(directory)).map(async (path) => {
    const source = await Deno.readTextFile(path);
    const import_edges = source_import_edges(source);
    const workspace_path = relative(workspace_directory, path).replaceAll(
      sep,
      "/",
    );
    const project_source_path = relative(directory, path).replaceAll(sep, "/");
    return {
      absolute_path: path,
      imports: import_edges.map(({ specifier }) => specifier),
      path: workspace_path,
      production: source_is_production(project_source_path),
      runtime_imports: import_edges.filter(({ kind }) => kind === "runtime")
        .map(
          ({ specifier }) => specifier,
        ),
      source,
    };
  }));
}

function command_source_references(command: string): readonly string[] {
  const references: string[] = [];
  const source_path_pattern =
    /(?:^|[\s"'=])((?:\.{0,2}\/)?[A-Za-z0-9_@][A-Za-z0-9_@./-]*\.(?:blot|js|mjs|ts|tsx))(?=$|[\s"'`,;])/g;
  for (const match of command.matchAll(source_path_pattern)) {
    const reference = match[1];
    if (reference !== undefined) references.push(reference);
  }
  return references;
}

function package_entrypoint_references(
  manifest: Record<string, unknown>,
  manifest_path: string,
): readonly string[] {
  const references: string[] = [];
  for (const field of ["browser", "main", "module"]) {
    const value = manifest[field];
    if (typeof value === "string") references.push(value);
  }

  const bin = manifest.bin;
  if (typeof bin === "string") references.push(bin);
  else if (bin !== undefined) {
    if (!is_record(bin)) {
      throw new Error(
        `${manifest_path} field bin must contain a path or object`,
      );
    }
    for (const [name, value] of Object.entries(bin)) {
      if (typeof value !== "string") {
        throw new Error(
          `${manifest_path} field bin entry ${
            JSON.stringify(name)
          } must contain a path`,
        );
      }
      references.push(value);
    }
  }

  const scripts = manifest.scripts;
  if (scripts === undefined) return references;
  if (!is_record(scripts)) {
    throw new Error(`${manifest_path} field scripts must contain an object`);
  }
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== "string") {
      throw new Error(
        `${manifest_path} script ${
          JSON.stringify(name)
        } must contain a command`,
      );
    }
    const category = name.split(":", 1)[0];
    if (!application_entrypoint_script_categories.includes(category)) continue;
    references.push(...command_source_references(command));
  }
  return references;
}

function html_attribute(
  attributes: string,
  name: "src" | "type",
): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "iu").exec(
    attributes,
  );
  return match?.[2];
}

async function html_entrypoint_references(
  directory: string,
): Promise<readonly string[]> {
  const index_path = resolve(directory, "index.html");
  let source: string;
  try {
    source = await Deno.readTextFile(index_path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  const references: string[] = [];
  for (const match of source.matchAll(/<script\b([^>]*)>/giu)) {
    const attributes = match[1];
    if (attributes === undefined) continue;
    if (html_attribute(attributes, "type")?.toLowerCase() !== "module") {
      continue;
    }
    const reference = html_attribute(attributes, "src")?.split(/[?#]/u)[0];
    if (reference !== undefined && reference.length > 0) {
      references.push(
        reference.startsWith("/") ? reference.slice(1) : reference,
      );
    }
  }
  return references;
}

async function blot_entrypoint_references(
  directory: string,
): Promise<readonly string[]> {
  const manifest_path = resolve(directory, "blot.json");
  let source: string;
  try {
    source = await Deno.readTextFile(manifest_path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  const manifest = parse_json_object(source, manifest_path);
  if (manifest.schema !== "blot-project" || manifest.version !== 1) {
    throw new Error(`${manifest_path} must contain Blot project version 1`);
  }
  const units = manifest.units;
  if (!is_record(units)) {
    throw new Error(`${manifest_path} field units must contain an object`);
  }
  const entry_unit = required_string(manifest, "entryUnit", manifest_path);
  if (!(entry_unit in units)) {
    throw new Error(
      `${manifest_path} entry unit ${
        JSON.stringify(entry_unit)
      } is missing from units`,
    );
  }
  return Object.entries(units).map(([name, reference]) => {
    if (typeof reference !== "string") {
      throw new Error(
        `${manifest_path} unit ${JSON.stringify(name)} must contain a path`,
      );
    }
    return reference;
  });
}

async function application_entrypoint_paths(
  directory: string,
  manifest: Record<string, unknown>,
  manifest_path: string,
  source_files: readonly SourceFile[],
): Promise<readonly string[]> {
  const source_paths = new Set(
    source_files.map(({ absolute_path }) => absolute_path),
  );
  const references = [
    ...package_entrypoint_references(manifest, manifest_path),
    ...await html_entrypoint_references(directory),
    ...await blot_entrypoint_references(directory),
  ];
  const entrypoints = new Set<string>();
  for (const reference of references) {
    const absolute_path = resolve(directory, reference);
    if (!path_is_within(directory, absolute_path)) continue;
    if (!source_paths.has(absolute_path)) {
      throw new Error(
        `${manifest_path} application entrypoint ${
          JSON.stringify(reference)
        } does not exist`,
      );
    }
    entrypoints.add(absolute_path);
  }
  return [...entrypoints].sort();
}

async function validate_export_files(
  directory: string,
  exports: ReadonlyMap<string, readonly string[]>,
  manifest_path: string,
): Promise<void> {
  for (const [subpath, targets] of exports) {
    for (const target of targets) {
      if (target.includes("*")) continue;
      const absolute_target = resolve(directory, target);
      if (!path_is_within(directory, absolute_target)) {
        throw new Error(
          `${manifest_path} export ${JSON.stringify(subpath)} target ${
            JSON.stringify(target)
          } is outside package directory ${JSON.stringify(directory)}`,
        );
      }
      let target_stat: Deno.FileInfo;
      try {
        target_stat = await Deno.stat(absolute_target);
      } catch (cause) {
        if (!(cause instanceof Deno.errors.NotFound)) throw cause;
        throw new Error(
          `${manifest_path} export ${JSON.stringify(subpath)} target ${
            JSON.stringify(target)
          } does not exist`,
          { cause },
        );
      }
      if (!target_stat.isFile) {
        throw new Error(
          `${manifest_path} export ${JSON.stringify(subpath)} target ${
            JSON.stringify(target)
          } must be a file`,
        );
      }
    }
  }
}

function dependency_names(
  manifest: Record<string, unknown>,
  path: string,
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const field of dependency_fields) {
    const value = manifest[field];
    if (value === undefined) continue;
    if (!is_record(value)) {
      throw new Error(`${path} field ${field} must contain an object`);
    }
    for (const [name, version] of Object.entries(value)) {
      if (typeof version !== "string") {
        throw new Error(
          `${path} dependency ${name} must have a string version`,
        );
      }
      names.add(name);
    }
  }
  return names;
}

async function read_projects(root: string): Promise<readonly InkProject[]> {
  const project_paths: string[] = [];
  for (const project_root of project_roots) {
    for await (
      const directory_entry of Deno.readDir(resolve(root, project_root))
    ) {
      if (!directory_entry.isDirectory) continue;
      const project_path = `${project_root}/${directory_entry.name}`;
      try {
        const manifest_stat = await Deno.stat(
          resolve(root, project_path, "package.json"),
        );
        if (manifest_stat.isFile) project_paths.push(project_path);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) continue;
        throw error;
      }
    }
  }

  return await Promise.all(
    project_paths.sort().map(async (project_path) => {
      const directory = resolve(root, project_path);
      const manifest_path = resolve(directory, "package.json");
      const manifest = parse_json_object(
        await Deno.readTextFile(manifest_path),
        manifest_path,
      );
      const ink = manifest.ink;
      if (!is_record(ink)) {
        throw new Error(`${manifest_path} field ink must contain an object`);
      }
      const exports = manifest.exports === undefined
        ? new Map<string, readonly string[]>()
        : parse_package_exports(manifest.exports, manifest_path);
      await validate_export_files(directory, exports, manifest_path);
      const kind = parse_kind(ink.kind, manifest_path);
      const source_files = await read_source_files(directory);
      return {
        directory,
        entrypoint_paths: kind === "application"
          ? await application_entrypoint_paths(
            directory,
            manifest,
            manifest_path,
            source_files,
          )
          : [],
        exports,
        internal_dependencies: dependency_names(manifest, manifest_path),
        kind,
        name: required_string(manifest, "name", manifest_path),
        path: project_path,
        source_files,
      };
    }),
  );
}

function cycle_violations(projects: readonly InkProject[]): readonly string[] {
  const projects_by_name = new Map(
    projects.map((project) => [project.name, project]),
  );
  const indices = new Map<string, number>();
  const low_links = new Map<string, number>();
  const active = new Set<string>();
  const stack: string[] = [];
  const cycles: string[] = [];
  let next_index = 0;

  function visit(name: string): void {
    indices.set(name, next_index);
    low_links.set(name, next_index);
    next_index += 1;
    stack.push(name);
    active.add(name);

    const project = projects_by_name.get(name);
    if (project === undefined) {
      throw new Error(`missing project ${name} during cycle check`);
    }
    for (const dependency of project.internal_dependencies) {
      if (!projects_by_name.has(dependency)) continue;
      if (!indices.has(dependency)) {
        visit(dependency);
        low_links.set(
          name,
          Math.min(low_links.get(name) ?? 0, low_links.get(dependency) ?? 0),
        );
      } else if (active.has(dependency)) {
        low_links.set(
          name,
          Math.min(low_links.get(name) ?? 0, indices.get(dependency) ?? 0),
        );
      }
    }

    if (low_links.get(name) !== indices.get(name)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop();
      if (member === undefined) break;
      active.delete(member);
      component.push(member);
      if (member === name) break;
    }
    const self_cycle = component.length === 1 &&
      project.internal_dependencies.has(name);
    if (component.length > 1 || self_cycle) {
      cycles.push(`dependency.cycle:${component.sort().join(",")}`);
    }
  }

  for (const project of projects) {
    if (!indices.has(project.name)) visit(project.name);
  }
  return cycles.sort();
}

interface ReachableWorkspaceImports {
  readonly packages: ReadonlySet<string>;
  readonly subpaths_by_package: ReadonlyMap<string, ReadonlySet<string>>;
}

function reachable_workspace_imports(
  application: InkProject,
  projects_by_name: ReadonlyMap<string, InkProject>,
): ReachableWorkspaceImports {
  const source_by_path = new Map(
    [...projects_by_name.values()].flatMap((project) =>
      project.source_files.map((source_file) =>
        [source_file.absolute_path, source_file] as const
      )
    ),
  );
  const entrypoint_paths = new Set(application.entrypoint_paths);
  const pending = application.source_files.filter(({ absolute_path }) =>
    entrypoint_paths.has(absolute_path)
  );
  const visited = new Set<string>();
  const packages = new Set<string>([application.name]);
  const subpaths_by_package = new Map<string, Set<string>>();
  while (pending.length > 0) {
    const source_file = pending.pop();
    if (source_file === undefined || visited.has(source_file.absolute_path)) {
      continue;
    }
    visited.add(source_file.absolute_path);
    for (const specifier of source_file.runtime_imports) {
      if (specifier.startsWith(".")) {
        const target = source_by_path.get(
          resolve(dirname(source_file.absolute_path), specifier),
        );
        if (target !== undefined) pending.push(target);
        continue;
      }
      if (!source_file.production) continue;
      const imported_package = package_name(specifier);
      if (imported_package === undefined) continue;
      const project = projects_by_name.get(imported_package);
      if (project === undefined) continue;
      const subpath = package_export_subpath(specifier, imported_package);
      if (subpath === undefined) continue;
      packages.add(imported_package);
      const imported_subpaths = subpaths_by_package.get(imported_package) ??
        new Set<string>();
      imported_subpaths.add(subpath);
      subpaths_by_package.set(imported_package, imported_subpaths);
      for (const target of project.exports.get(subpath) ?? []) {
        const target_source = source_by_path.get(
          resolve(project.directory, target),
        );
        if (target_source !== undefined) pending.push(target_source);
      }
    }
  }
  return Object.freeze({
    packages,
    subpaths_by_package,
  });
}

function package_export_specifier(
  package_name: string,
  subpath: string,
): string {
  return subpath === "." ? package_name : `${package_name}${subpath.slice(1)}`;
}

export function unproved_stable_export_specifiers(
  package_name: string,
  exports: ReadonlyMap<string, readonly string[]>,
  proven: ReadonlySet<string>,
): readonly string[] {
  const unproved: string[] = [];
  for (const [subpath, targets] of exports) {
    if (scenario_export_is_experimental(subpath, targets)) continue;
    if (proven.has(subpath)) continue;
    unproved.push(package_export_specifier(package_name, subpath));
  }
  return unproved.sort();
}

async function read_scenario(
  application: InkProject,
): Promise<ApplicationScenario | undefined> {
  const path = resolve(application.directory, "scenario.json");
  try {
    return parse_application_scenario(await Deno.readTextFile(path), path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

export async function workspace_proof_report(
  root = workspace_directory,
): Promise<WorkspaceProofReport> {
  const projects = await read_projects(root);
  const packages = projects.map((project) => ({
    name: project.name,
    path: project.path,
    kind: project.kind,
    exports: [...project.exports.entries()].map(([subpath, targets]) => ({
      subpath,
      targets,
      specifier: package_export_specifier(project.name, subpath),
      stability: scenario_export_is_experimental(subpath, targets)
        ? "experimental" as const
        : "stable" as const,
    })),
  }));
  const scenarios: WorkspaceProofScenario[] = [];
  for (const application of projects) {
    if (application.kind !== "application") continue;
    const scenario = await read_scenario(application);
    if (scenario === undefined) {
      throw new Error(
        `application ${application.name} is missing ${
          resolve(application.directory, "scenario.json")
        }`,
      );
    }
    scenarios.push({
      application: application.name,
      path: `${application.path}/scenario.json`,
      scenario,
    });
  }
  return Object.freeze({
    version: 1,
    packages: Object.freeze(packages),
    scenarios: Object.freeze(scenarios),
  });
}

export async function workspace_violations(
  options: WorkspaceCheckOptions = {},
): Promise<readonly string[]> {
  const root = options.root ?? workspace_directory;
  const projects = await read_projects(root);
  const projects_by_name = new Map<string, InkProject>();
  for (const project of projects) {
    if (projects_by_name.has(project.name)) {
      throw new Error(
        `workspace package name ${project.name} is declared more than once`,
      );
    }
    projects_by_name.set(project.name, project);
  }
  const violations = new Set<string>();

  const root_manifest_path = resolve(root, "package.json");
  const root_manifest = parse_json_object(
    await Deno.readTextFile(root_manifest_path),
    root_manifest_path,
  );
  for (const duplicate_field of ["catalog", "workspaces"]) {
    if (root_manifest[duplicate_field] !== undefined) {
      violations.add(`root.duplicate-workspace-field:${duplicate_field}`);
    }
  }

  for (const project of projects) {
    const expected_kind = ink_project_kind(project.path);
    if (project.kind !== expected_kind) {
      violations.add(
        `metadata.kind:${project.name}=${project.kind},expected=${expected_kind}`,
      );
    }
    for (const dependency of project.internal_dependencies) {
      const target = projects_by_name.get(dependency);
      if (target === undefined) continue;
      if (!dependency_direction_allowed(project.kind, target.kind)) {
        violations.add(`dependency.direction:${project.name}->${target.name}`);
      }
    }
    for (
      const violation of export_location_violations(
        project.name,
        project.exports,
      )
    ) {
      violations.add(violation);
    }
    for (const targets of project.exports.values()) {
      for (const target of targets) {
        if (target.includes("*")) {
          violations.add(`export.wildcard:${project.name}:${target}`);
        }
        if (
          /(?:^|\/)(?:legacy|migration|[^/]+_(?:bench|test))\.[^/]+$/.test(
            target,
          )
        ) {
          violations.add(`export.non-production:${project.name}:${target}`);
        }
      }
    }

    const used_packages = new Set<string>();
    for (const source_file of project.source_files) {
      if (
        source_file.production &&
        /\bexport\s*\*\s*from\s*["']/.test(source_file.source)
      ) {
        violations.add(`export.source-wildcard:${source_file.path}`);
      }
      for (const specifier of source_file.imports) {
        if (specifier.startsWith(".")) {
          const target_path = resolve(
            dirname(source_file.absolute_path),
            specifier,
          );
          const target = projects.find((candidate) =>
            path_is_within(candidate.directory, target_path)
          );
          if (target !== undefined && target.name !== project.name) {
            violations.add(
              `import.cross-workspace:${source_file.path}:${specifier}`,
            );
          }
          if (
            source_file.production &&
            !source_file.path.includes("/experimental/") &&
            specifier.split("/").includes("experimental")
          ) {
            violations.add(
              `import.experimental:${source_file.path}:${specifier}`,
            );
          }
          continue;
        }
        const imported_package = package_name(specifier);
        if (imported_package === undefined) continue;
        if (imported_package !== project.name) {
          used_packages.add(imported_package);
        }
        const imported_project = projects_by_name.get(imported_package);
        const imported_subpath = package_export_subpath(
          specifier,
          imported_package,
        );
        const imported_targets = imported_subpath === undefined
          ? undefined
          : imported_project?.exports.get(imported_subpath);
        if (
          source_file.production &&
          !source_file.path.includes("/experimental/") &&
          (specifier.split("/").includes("experimental") ||
            (imported_subpath !== undefined &&
              imported_targets !== undefined &&
              scenario_export_is_experimental(
                imported_subpath,
                imported_targets,
              )))
        ) {
          violations.add(
            `import.experimental:${source_file.path}:${specifier}`,
          );
        }
        if (
          imported_package.startsWith("@ink/") &&
          imported_package !== project.name &&
          !project.internal_dependencies.has(imported_package)
        ) {
          violations.add(
            `dependency.undeclared:${project.name}->${imported_package}`,
          );
        }
      }
    }
    for (const dependency of project.internal_dependencies) {
      if (projects_by_name.has(dependency) && !used_packages.has(dependency)) {
        violations.add(`dependency.unused:${project.name}->${dependency}`);
      }
    }
  }

  for (const violation of cycle_violations(projects)) violations.add(violation);

  const applications = projects.filter((project) =>
    project.kind === "application"
  );
  const editors = projects.filter((project) => project.kind === "editor");
  const application_proof_results: ApplicationProofResult[] = [];
  for (const application of applications) {
    const scenario = await read_scenario(application);
    const application_has_entrypoints = application.entrypoint_paths.length > 0;
    if (!application_has_entrypoints) {
      violations.add(`application.entrypoint-missing:${application.name}`);
    }
    const editor_dependencies = [...application.internal_dependencies].filter(
      (dependency) => projects_by_name.get(dependency)?.kind === "editor",
    );
    const expected_editor_count = scenario?.role === "editor_game" ? 1 : 0;
    if (editor_dependencies.length !== expected_editor_count) {
      violations.add(
        `application.editor-count:${application.name}=${editor_dependencies.length}`,
      );
    }
    if (scenario === undefined) {
      violations.add(`scenario.missing:${application.name}`);
      continue;
    }
    let scenario_can_credit_stability = scenario.role === "editor_game" &&
      editor_dependencies.length === 1 && application_has_entrypoints;
    if (
      scenario.role === "editor_game" &&
      !application.internal_dependencies.has(scenario.editor)
    ) {
      violations.add(
        `scenario.editor-not-dependency:${application.name}->${scenario.editor}`,
      );
      scenario_can_credit_stability = false;
    }
    if (
      scenario.role === "editor_game" &&
      projects_by_name.get(scenario.editor)?.kind !== "editor"
    ) {
      violations.add(
        `scenario.editor-invalid:${application.name}->${scenario.editor}`,
      );
      scenario_can_credit_stability = false;
    }
    const reachable = reachable_workspace_imports(
      application,
      projects_by_name,
    );
    const valid_proof_exports = new Map<string, Set<string>>();
    for (const proof of scenario.proofs) {
      let proof_is_valid = true;
      const covered_project = projects_by_name.get(proof.package);
      if (
        covered_project === undefined || covered_project.kind === "application"
      ) {
        violations.add(
          `scenario.package-invalid:${application.name}->${proof.package}`,
        );
        continue;
      }
      if (!reachable.packages.has(proof.package)) {
        violations.add(
          `scenario.package-unreachable:${application.name}->${proof.package}`,
        );
        continue;
      }
      const imported_subpaths = reachable.subpaths_by_package.get(
        proof.package,
      ) ?? new Set<string>();
      for (const subpath of proof.exports) {
        const targets = covered_project.exports.get(subpath);
        if (targets === undefined) {
          violations.add(
            `scenario.export-missing:${application.name}->${
              package_export_specifier(proof.package, subpath)
            }`,
          );
          proof_is_valid = false;
          continue;
        }
        if (!imported_subpaths.has(subpath)) {
          violations.add(
            `scenario.export-unimported:${application.name}->${
              package_export_specifier(proof.package, subpath)
            }`,
          );
          proof_is_valid = false;
        }
        if (scenario_export_is_experimental(subpath, targets)) {
          violations.add(
            `scenario.export-experimental:${application.name}->${
              package_export_specifier(proof.package, subpath)
            }`,
          );
          proof_is_valid = false;
        }
      }
      if (proof_is_valid) {
        const covered = valid_proof_exports.get(proof.package) ??
          new Set<string>();
        for (const subpath of proof.exports) covered.add(subpath);
        valid_proof_exports.set(proof.package, covered);
      }
    }

    await run_scenario_commands({
      scenario,
      scenario_path: resolve(application.directory, "scenario.json"),
      working_directory: root,
      ...(options.execute_scenario_command === undefined
        ? {}
        : { execute: options.execute_scenario_command }),
      ...(options.reports === undefined ? {} : { reports: options.reports }),
    });
    application_proof_results.push({
      editor_wiring: scenario_can_credit_stability ? "valid" : "invalid",
      scenario,
      validated_exports: valid_proof_exports,
    });
  }
  const coverage = collect_scenario_coverage(
    editors.map((editor) => editor.name),
    application_proof_results,
  );
  for (const violation of coverage.owner_violations) {
    violations.add(violation);
  }
  for (const project of projects) {
    if (project.kind !== "core") continue;
    const proven = coverage.proven_exports.get(project.name) ?? new Set();
    for (
      const specifier of unproved_stable_export_specifiers(
        project.name,
        project.exports,
        proven,
      )
    ) {
      violations.add(`export.unproved:${specifier}`);
    }
  }

  return [...violations].sort();
}

function scenario_export_is_experimental(
  subpath: string,
  targets: readonly string[],
): boolean {
  return export_namespace_is_experimental(subpath) ||
    targets.some(export_target_is_experimental);
}

async function run(): Promise<void> {
  const unsupported_arguments = Deno.args.filter((argument) =>
    argument !== "--list"
  );
  if (unsupported_arguments.length > 0) {
    throw new Error(
      `unsupported workspace check arguments: ${
        unsupported_arguments.join(", ")
      }`,
    );
  }
  const violations = await workspace_violations();
  if (Deno.args.includes("--list")) {
    console.log(JSON.stringify({ version: 1, violations }, null, 2));
    return;
  }

  if (violations.length > 0) {
    throw new Error(`workspace violations:\n${violations.join("\n")}`);
  }
  console.log("checked workspace with no architecture violations");
}

if (import.meta.main) await run();
