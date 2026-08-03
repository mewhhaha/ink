const app_directory = new URL("./", import.meta.url);
const ink_blot_directory = new URL("../../packages/blot/", app_directory);

export const game_development = {
  source_directories: [new URL("blot/", app_directory), ink_blot_directory],
  resource_directories: [{
    source_directory: new URL("assets/", app_directory),
    public_directory: new URL("generated/assets/", app_directory),
  }],
  public_directory: new URL("generated/", app_directory),
  build: {
    command: "deno",
    arguments: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-run=deno",
      "build.ts",
    ],
    working_directory: app_directory,
  },
} as const;
