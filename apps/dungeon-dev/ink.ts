import { blot } from "@ink/blot/adapter.ts";
import { build_blot_game } from "@ink/blot/build.ts";
import { define_ink_application } from "@ink/vite";
import { adventure_project_document } from "./src/editor/vite.ts";
import { compile_adventure_project } from "./src/project.ts";

const app_directory = new URL("./", import.meta.url);
export const game_adapter = blot({
  game_id: "dungeon_development",
  data_assets: [{ id: 0, url: "/assets/levels/starter.json" }],
});

const configure_application = define_ink_application({
  app_directory,
  source_directories: ["projects/", "src/blot/", "../../packages/blot/"],
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
      adventure_project_document(
        new URL("projects/starter.json", app_directory),
      ),
      ...(configuration.plugins ?? []),
      react.default(),
      babel({ presets: [react.reactCompilerPreset()] }),
      tailwindcss(),
    ],
  };
}

if (import.meta.main) {
  const project = compile_adventure_project(
    await Deno.readTextFile(new URL("projects/starter.json", app_directory)),
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
    generated_assets: [{
      id: "levels/starter.json",
      kind: "json",
      bytes: new TextEncoder().encode(project.level_asset_source),
    }],
    public_directory: new URL("generated/", app_directory),
    working_directory: app_directory,
  });
  await write_text_atomically(
    new URL("generated/dungeon-project.json", app_directory),
    project.canonical_source,
  );
}

async function write_text_atomically(path: URL, source: string): Promise<void> {
  await Deno.mkdir(new URL("./", path), { recursive: true });
  const pending = new URL(
    `.${path.pathname.split("/").at(-1)}.${Deno.pid}.pending`,
    new URL("./", path),
  );
  try {
    await Deno.writeTextFile(pending, source);
    await Deno.rename(pending, path);
  } finally {
    try {
      await Deno.remove(pending);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
}
