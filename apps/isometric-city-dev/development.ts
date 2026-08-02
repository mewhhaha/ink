const app_directory = new URL("./", import.meta.url);
const blot_directory = new URL("../../../blot/", import.meta.url);
const ink_blot_directory = new URL("../../packages/blot/", app_directory);

export const isometric_city_development = {
  source_directories: [new URL("blot/", app_directory), ink_blot_directory],
  public_directory: new URL("generated/", app_directory),
  build: {
    command: "deno",
    arguments: ["run", "-A", "build.ts"],
    working_directory: app_directory,
  },
  compiler_service: {
    command: "deno",
    arguments: [
      "run",
      "-A",
      new URL("src/cli.ts", blot_directory).pathname,
      "serve",
      "--port=0",
    ],
    working_directory: blot_directory,
    url_environment: "BLOT_COMPILER_URL",
  },
} as const;
