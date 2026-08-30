import { build_blot_game } from "@ink/blot/build.ts";
import { define_ink_application } from "@ink/vite";
import { narrative_project_document } from "./src/editor/vite.ts";
import { game_adapter } from "./src/game_adapter.ts";
import { compile_narrative_project } from "./src/project.ts";

const app_directory = new URL("./", import.meta.url);
export { game_adapter } from "./src/game_adapter.ts";
const project_file = configured_project_file();

const configure_application = define_ink_application({
  app_directory,
  source_directories: [
    new URL("./", project_file),
    "src/blot/",
    "../../packages/blot/",
  ],
  build: {
    command: "deno",
    arguments: [
      "run",
      "--config",
      "../../deno.json",
      "--allow-env=INK_NARRATIVE_PROJECT_FILE",
      "--allow-read",
      "--allow-write",
      "--allow-run=deno",
      "ink.ts",
    ],
  },
});

export default async function configure(
  environment: Parameters<typeof configure_application>[0],
) {
  const [configuration, { default: babel }, { default: tailwindcss }, react] =
    await Promise.all([
      configure_application(environment),
      import("@rolldown/plugin-babel"),
      import("@tailwindcss/vite"),
      import("@vitejs/plugin-react"),
    ]);
  return {
    ...configuration,
    plugins: [
      narrative_project_document(project_file),
      ...(configuration.plugins ?? []),
      react.default(),
      babel({ presets: [react.reactCompilerPreset()] }),
      tailwindcss(),
    ],
  };
}

if (import.meta.main) {
  const project = compile_narrative_project(
    await Deno.readTextFile(project_file),
  );
  await write_text_atomically(
    new URL("src/blot/generated/project.blot", app_directory),
    project.blot_source,
  );
  await build_blot_game({
    artifact_name: game_adapter.artifact_name,
    assets_directory: new URL("assets/", app_directory),
    compiler: new URL("../../../blot/src/cli.ts", import.meta.url),
    entrypoint: new URL("src/blot/game/main.blot", app_directory),
    public_directory: new URL("generated/", app_directory),
    working_directory: app_directory,
  });
  await write_text_atomically(
    new URL("generated/narrative-project.json", app_directory),
    project.canonical_source,
  );
}

function configured_project_file(): URL {
  const configured = typeof Deno === "undefined"
    ? process.env.INK_NARRATIVE_PROJECT_FILE
    : Deno.env.get("INK_NARRATIVE_PROJECT_FILE");
  const project_file = configured === undefined || configured.trim() === ""
    ? new URL("projects/starter.json", app_directory)
    : new URL(configured, app_directory);
  if (project_file.protocol !== "file:") {
    throw new Error(
      `narrative project ${JSON.stringify(project_file.href)} must be local`,
    );
  }
  return project_file;
}

async function write_text_atomically(path: URL, source: string): Promise<void> {
  try {
    if (await Deno.readTextFile(path) === source) return;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  await Deno.mkdir(new URL("./", path), { recursive: true });
  const pending = new URL(
    `.${path.pathname.split("/").at(-1)}.${Deno.pid}.pending`,
    new URL("./", path),
  );
  try {
    await Deno.writeTextFile(pending, source);
    await Deno.rename(pending, path);
  } catch (error) {
    try {
      await Deno.remove(pending);
    } catch (cleanup_error) {
      if (!(cleanup_error instanceof Deno.errors.NotFound)) {
        throw new AggregateError(
          [error, cleanup_error],
          `failed to write and clean up ${JSON.stringify(path.href)}`,
        );
      }
    }
    throw error;
  }
}
