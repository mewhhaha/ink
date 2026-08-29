import { fileURLToPath } from "node:url";

const workspace_directory = fileURLToPath(
  new URL("../../", import.meta.url),
);
const blot_source_directories = [
  fileURLToPath(new URL("../../apps", import.meta.url)),
  fileURLToPath(new URL("../../packages/blot", import.meta.url)),
];

export function migrate_blot_source(source: string): string {
  return source.split("\n").map((line) => {
    const discarded_effect = line.match(/^([ \t]*)<-[ \t]+(.*)$/u);
    if (discarded_effect) {
      return `${discarded_effect[1]}use ${discarded_effect[2]}`;
    }

    const bound_effect = line.match(
      /^([ \t]*)([?&!^]?[A-Za-z_][A-Za-z0-9_]*)[ \t]+<-[ \t]+(.*)$/u,
    );
    if (!bound_effect) return line;
    return `${bound_effect[1]}use ${bound_effect[2]} <- ${bound_effect[3]}`;
  }).join("\n");
}

async function* blot_source_paths(
  directory: string,
): AsyncGenerator<string> {
  const directory_entries = [];
  for await (const directory_entry of Deno.readDir(directory)) {
    directory_entries.push(directory_entry);
  }
  directory_entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const directory_entry of directory_entries) {
    const path = `${directory}/${directory_entry.name}`;
    if (directory_entry.isDirectory) {
      yield* blot_source_paths(path);
      continue;
    }
    if (directory_entry.isFile && directory_entry.name.endsWith(".blot")) {
      yield path;
    }
  }
}

async function run(): Promise<void> {
  const unsupported_arguments = Deno.args.filter((argument) =>
    argument !== "--check"
  );
  if (unsupported_arguments.length > 0) {
    throw new Error(
      `unsupported Blot syntax migration arguments: ${
        unsupported_arguments.join(", ")
      }`,
    );
  }

  const check_only = Deno.args.includes("--check");
  const changed_paths: string[] = [];
  for (const directory of blot_source_directories) {
    for await (const path of blot_source_paths(directory)) {
      const source = await Deno.readTextFile(path);
      const migrated_source = migrate_blot_source(source);
      if (migrated_source === source) continue;
      changed_paths.push(path.slice(workspace_directory.length));
      if (!check_only) await Deno.writeTextFile(path, migrated_source);
    }
  }

  if (check_only && changed_paths.length > 0) {
    throw new Error(
      `Blot syntax migration required for: ${changed_paths.join(", ")}`,
    );
  }

  const action = check_only ? "checked" : "migrated";
  console.log(`${action} Blot syntax in ${changed_paths.length} files`);
}

if (import.meta.main) await run();
