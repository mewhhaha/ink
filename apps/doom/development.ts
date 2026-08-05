const app_directory = new URL("./", import.meta.url);
const ink_blot_directory = new URL("../../packages/blot/", app_directory);

export const doom_development = {
  source_directories: [new URL("blot/", app_directory), ink_blot_directory],
  resource_directories: [],
  public_directory: new URL("generated/", app_directory),
  build: {
    command: "deno",
    arguments: [
      "run",
      "--config",
      new URL("deno.json", new URL("vendor/blot/", app_directory)).pathname,
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "build.ts",
    ],
    working_directory: app_directory,
  },
} as const;
