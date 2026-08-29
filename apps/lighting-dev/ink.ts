import { define_ink_application } from "@ink/vite";

export default define_ink_application({
  app_directory: new URL("./", import.meta.url),
  source_directories: ["src/"],
  resource_directories: [],
});
