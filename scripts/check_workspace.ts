import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ink_project_kind,
  type InkProjectKind,
} from "./workspace/sync_workspace_manifests.ts";

const workspace_directory = fileURLToPath(new URL("../", import.meta.url));
const project_roots = ["apps", "editors", "packages"];
const source_extensions = [".blot", ".js", ".mjs", ".ts", ".tsx"];
const dependency_fields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

interface InkProject {
  readonly directory: string;
  readonly exports: readonly string[];
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
  readonly source: string;
}

export interface ApplicationScenario {
  readonly browser_command: string;
  readonly edit: string;
  readonly editor: string;
  readonly expected_outcome: string;
  readonly headless_command: string;
  readonly stable_packages: readonly string[];
  readonly version: 1;
}

export interface DebtDifference {
  readonly stale: readonly string[];
  readonly unexpected: readonly string[];
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
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} field ${field} must be a non-empty string`);
  }
  return value;
}

function string_array(
  record: Record<string, unknown>,
  field: string,
  path: string,
): readonly string[] {
  const value = record[field];
  if (
    !Array.isArray(value) ||
    value.some((element) => typeof element !== "string" || element.length === 0)
  ) {
    throw new Error(
      `${path} field ${field} must be an array of non-empty strings`,
    );
  }
  return value;
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
  if (record.version !== 1) {
    throw new Error(`${path} version must be 1`);
  }
  const stable_packages = string_array(record, "stable_packages", path);
  if (new Set(stable_packages).size !== stable_packages.length) {
    throw new Error(`${path} stable_packages must not contain duplicates`);
  }
  return {
    version: 1,
    editor: required_string(record, "editor", path),
    stable_packages,
    headless_command: required_string(record, "headless_command", path),
    browser_command: required_string(record, "browser_command", path),
    edit: required_string(record, "edit", path),
    expected_outcome: required_string(record, "expected_outcome", path),
  };
}

export function source_imports(source: string): readonly string[] {
  const imports = new Set<string>();
  const static_pattern =
    /\b(?:import|export)\s+(?:type\s+)?(?:[^"'();]*?\s+from\s+)?["']([^"']+)["']/g;
  const dynamic_pattern = /\bimport\s*\(\s*["']([^"']+)["']/g;
  for (const pattern of [static_pattern, dynamic_pattern]) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) imports.add(specifier);
    }
  }
  return [...imports].sort();
}

export function dependency_direction_allowed(
  source_kind: InkProjectKind,
  target_kind: InkProjectKind,
): boolean {
  if (source_kind === "application") return target_kind !== "application";
  return target_kind === "core";
}

export function compare_architecture_debt(
  violations: readonly string[],
  accepted_debt: readonly string[],
): DebtDifference {
  const current = new Set(violations);
  const accepted = new Set(accepted_debt);
  return {
    unexpected: [...current].filter((violation) => !accepted.has(violation))
      .sort(),
    stale: [...accepted].filter((violation) => !current.has(violation)).sort(),
  };
}

function export_targets(value: unknown, path: string): readonly string[] {
  if (typeof value === "string") return [value];
  if (!is_record(value)) {
    throw new Error(
      `${path} exports must contain strings or condition objects`,
    );
  }
  return Object.values(value).flatMap((target) => export_targets(target, path));
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
    const workspace_path = relative(workspace_directory, path).replaceAll(
      sep,
      "/",
    );
    return {
      absolute_path: path,
      imports: source_imports(source),
      path: workspace_path,
      production: source_is_production(workspace_path),
      source,
    };
  }));
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
      return {
        directory,
        exports: manifest.exports === undefined
          ? []
          : export_targets(manifest.exports, manifest_path),
        internal_dependencies: dependency_names(manifest, manifest_path),
        kind: parse_kind(ink.kind, manifest_path),
        name: required_string(manifest, "name", manifest_path),
        path: project_path,
        source_files: await read_source_files(directory),
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

function reachable_packages(
  application: InkProject,
  projects_by_name: ReadonlyMap<string, InkProject>,
): ReadonlySet<string> {
  const reachable = new Set<string>();
  const pending = [application.name];
  while (pending.length > 0) {
    const name = pending.pop();
    if (name === undefined || reachable.has(name)) continue;
    reachable.add(name);
    const project = projects_by_name.get(name);
    if (project === undefined) continue;
    for (const dependency of project.internal_dependencies) {
      pending.push(dependency);
    }
  }
  return reachable;
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

export async function workspace_violations(
  root = workspace_directory,
): Promise<readonly string[]> {
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
    for (const target of project.exports) {
      if (target.includes("*")) {
        violations.add(`export.wildcard:${project.name}:${target}`);
      }
      if (
        /(?:^|\/)(?:legacy|migration|[^/]+_(?:bench|test))\.[^/]+$/.test(target)
      ) {
        violations.add(`export.non-production:${project.name}:${target}`);
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
        if (
          source_file.production &&
          !source_file.path.includes("/experimental/") &&
          specifier.split("/").includes("experimental")
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
  const proven_packages = new Set<string>();
  for (const application of applications) {
    const editor_dependencies = [...application.internal_dependencies].filter(
      (dependency) => projects_by_name.get(dependency)?.kind === "editor",
    );
    if (editor_dependencies.length !== 1) {
      violations.add(
        `application.editor-count:${application.name}=${editor_dependencies.length}`,
      );
    }
    const scenario = await read_scenario(application);
    if (scenario === undefined) {
      violations.add(`scenario.missing:${application.name}`);
      continue;
    }
    if (!application.internal_dependencies.has(scenario.editor)) {
      violations.add(
        `scenario.editor-not-dependency:${application.name}->${scenario.editor}`,
      );
    }
    if (projects_by_name.get(scenario.editor)?.kind !== "editor") {
      violations.add(
        `scenario.editor-invalid:${application.name}->${scenario.editor}`,
      );
    }
    const reachable = reachable_packages(application, projects_by_name);
    for (const package_name of scenario.stable_packages) {
      const covered_project = projects_by_name.get(package_name);
      if (
        covered_project === undefined || covered_project.kind === "application"
      ) {
        violations.add(
          `scenario.package-invalid:${application.name}->${package_name}`,
        );
        continue;
      }
      if (!reachable.has(package_name)) {
        violations.add(
          `scenario.package-unreachable:${application.name}->${package_name}`,
        );
        continue;
      }
      proven_packages.add(package_name);
    }
  }
  for (const editor of editors) {
    const owners = applications.filter((application) =>
      application.internal_dependencies.has(editor.name)
    );
    if (owners.length !== 1) {
      violations.add(`editor.owner-count:${editor.name}=${owners.length}`);
    }
  }
  for (const project of projects) {
    if (project.kind === "core" && !proven_packages.has(project.name)) {
      violations.add(`package.unproved:${project.name}`);
    }
  }

  return [...violations].sort();
}

function parse_accepted_debt(source: string, path: string): readonly string[] {
  const record = parse_json_object(source, path);
  if (record.version !== 1) throw new Error(`${path} version must be 1`);
  const violations = string_array(record, "violations", path);
  const sorted = [...violations].sort();
  if (new Set(violations).size !== violations.length) {
    throw new Error(`${path} violations must not contain duplicates`);
  }
  if (violations.some((violation, index) => violation !== sorted[index])) {
    throw new Error(`${path} violations must be sorted`);
  }
  return violations;
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

  const debt_path = resolve(workspace_directory, "architecture/debt.json");
  const accepted_debt = parse_accepted_debt(
    await Deno.readTextFile(debt_path),
    debt_path,
  );
  const difference = compare_architecture_debt(violations, accepted_debt);
  if (difference.unexpected.length > 0 || difference.stale.length > 0) {
    const messages = [
      ...difference.unexpected.map((violation) => `unexpected: ${violation}`),
      ...difference.stale.map((violation) => `stale: ${violation}`),
    ];
    throw new Error(
      `architecture debt does not match:\n${messages.join("\n")}`,
    );
  }
  console.log(
    `checked workspace with ${accepted_debt.length} temporary architecture debts`,
  );
}

if (import.meta.main) await run();
