import { fileURLToPath } from "node:url";
import { build, type Plugin } from "vite";

export interface InkSideEffectFreeBrowserModule {
  readonly source: string;
  readonly resolution_root: URL;
}

export interface InkServedBrowserModule {
  readonly path: string;
  readonly source: string;
}

export async function bundle_side_effect_free_browser_module(
  module: InkSideEffectFreeBrowserModule,
): Promise<string> {
  if (typeof module.source !== "string" || module.source.trim().length === 0) {
    throw new Error("Ink browser module source must be non-empty text");
  }
  if (module.resolution_root.protocol !== "file:") {
    throw new Error(
      `Ink browser module resolution root ${
        JSON.stringify(module.resolution_root.href)
      } must be a file URL`,
    );
  }
  const virtual_id = "\0ink:side-effect-free-browser-module";
  const built = await build({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    publicDir: false,
    root: fileURLToPath(module.resolution_root),
    plugins: [{
      name: "ink-side-effect-free-browser-module",
      resolveId(id) {
        if (id === "ink:side-effect-free-browser-module") return virtual_id;
      },
      load(id) {
        if (id === virtual_id) return module.source;
      },
    }],
    build: {
      minify: "oxc",
      write: false,
      rolldownOptions: {
        input: "ink:side-effect-free-browser-module",
        preserveEntrySignatures: "strict",
        treeshake: { moduleSideEffects: false },
        output: { codeSplitting: false, format: "es" },
      },
    },
  });
  if (!Array.isArray(built) && "close" in built) {
    throw new Error("Ink browser module unexpectedly started a watch build");
  }
  const outputs = (Array.isArray(built) ? built : [built]).flatMap((result) =>
    result.output
  );
  const entry_chunks = outputs.filter((output) =>
    output.type === "chunk" && output.isEntry
  );
  if (entry_chunks.length !== 1 || entry_chunks[0]?.type !== "chunk") {
    throw new Error(
      `Ink browser module produced ${entry_chunks.length} entry chunks`,
    );
  }
  return entry_chunks[0].code;
}

export function serve_browser_module(module: InkServedBrowserModule): Plugin {
  if (
    !module.path.startsWith("/") || module.path.includes("?") ||
    module.path.includes("#")
  ) {
    throw new Error(
      `Ink browser module path ${
        JSON.stringify(module.path)
      } must be an absolute URL path`,
    );
  }
  if (module.source.trim().length === 0) {
    throw new Error("Ink served browser module source must be non-empty text");
  }
  return {
    name: `ink-browser-module:${module.path}`,
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split("?", 1)[0];
        if (path !== module.path) {
          next();
          return;
        }
        response.statusCode = 200;
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Content-Type", "text/javascript; charset=utf-8");
        response.end(module.source);
      });
    },
  };
}
