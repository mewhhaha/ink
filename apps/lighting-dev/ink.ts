import { define_ink_application } from "@ink/vite";

const configure_application = define_ink_application({
  app_directory: new URL("./", import.meta.url),
  public_directory: "generated/public/",
  resource_directories: [],
  source_directories: ["src/"],
});

export default async function configure(
  environment: Parameters<typeof configure_application>[0],
) {
  const [configuration, react] = await Promise.all([
    configure_application(environment),
    import("@vitejs/plugin-react"),
  ]);
  return {
    ...configuration,
    plugins: [...(configuration.plugins ?? []), react.default()],
  };
}
