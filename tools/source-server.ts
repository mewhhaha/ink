async function removeTemporary(path: string) {
  try {
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

/** Shared development server: browser bundles stay cached until a dependency changes. */
export async function sourceServer(options: {
  root?: URL;
  importMap?: URL;
  port?: number;
  redirect?: string;
  watch?: string[];
} = {}) {
  const root = options.root ?? new URL("../", import.meta.url);
  const temporary = await Deno.makeTempDir({ prefix: "ink-source-" });
  const bundles = new Map<string, {
    dependencies: Set<string>;
    script: Promise<string>;
    ready: boolean;
  }>();
  const abort = new AbortController();
  let serial = 0;
  let disposed = false;
  const invalidate = (paths: string[]) => {
    for (const [path, entry] of bundles) {
      if (
        !entry.ready || paths.some((source) => entry.dependencies.has(source))
      ) {
        bundles.delete(path);
      }
    }
  };
  let watcher: Deno.FsWatcher | undefined;
  try {
    if (options.watch) {
      watcher = Deno.watchFs(options.watch, { recursive: true });
    }
  } catch (error) {
    await Deno.remove(temporary, { recursive: true });
    throw error;
  }
  const watching = (async () => {
    if (!watcher) return;
    for await (const event of watcher) invalidate(event.paths);
  })();
  let server: Deno.HttpServer<Deno.NetAddr>;
  try {
    server = Deno.serve(
      { hostname: "127.0.0.1", port: options.port ?? 0, onListen() {} },
      async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/" && options.redirect) {
          url.pathname = options.redirect;
          return Response.redirect(url, 307);
        }
        // Decode before resolving so escaped traversal cannot leave the source root.
        let source: URL;
        try {
          source = new URL(`.${decodeURIComponent(url.pathname)}`, root);
        } catch {
          return new Response("Invalid path", { status: 400 });
        }
        if (!source.href.startsWith(root.href)) {
          return new Response("Forbidden", { status: 403 });
        }
        try {
          const path = decodeURIComponent(source.pathname);
          let type = "text/plain";
          if (path.endsWith(".ts")) {
            type = "text/javascript";
            let entry = bundles.get(path);
            if (!entry) {
              const dependencies = new Set([path]);
              const output = new URL(`${serial++}.js`, `file://${temporary}/`);
              const outputPath = decodeURIComponent(output.pathname);
              const script = (async () => {
                try {
                  const args = [
                    "bundle",
                    "--no-check",
                    "--platform",
                    "browser",
                    "--sourcemap=external",
                    path,
                    "-o",
                    outputPath,
                  ];
                  if (options.importMap) {
                    args.push(
                      "--no-config",
                      "--no-lock",
                      "--import-map",
                      options.importMap.href,
                    );
                  }
                  const result = await new Deno.Command(Deno.execPath(), {
                    args,
                    signal: AbortSignal.any([
                      abort.signal,
                      AbortSignal.timeout(10000),
                    ]),
                    stdout: "null",
                    stderr: "piped",
                  }).output();
                  if (!result.success) {
                    throw new Error(new TextDecoder().decode(result.stderr));
                  }
                  const map = JSON.parse(
                    await Deno.readTextFile(`${outputPath}.map`),
                  );
                  for (const dependency of map.sources) {
                    dependencies.add(
                      decodeURIComponent(new URL(dependency, output).pathname),
                    );
                  }
                  const script = await Deno.readTextFile(output);
                  entry!.ready = true;
                  return script;
                } finally {
                  for (
                    const file of [outputPath, `${outputPath}.map`]
                  ) {
                    await removeTemporary(file);
                  }
                }
              })();
              entry = { dependencies, script, ready: false };
              bundles.set(path, entry);
              script.catch(() => {
                if (bundles.get(path)?.script === script) bundles.delete(path);
              });
            }
            return new Response(await entry.script, {
              headers: { "content-type": type },
            });
          }
          if (path.endsWith(".html")) type = "text/html";
          if (path.endsWith(".js")) type = "text/javascript";
          if (path.endsWith(".css")) type = "text/css";
          if (path.endsWith(".png")) type = "image/png";
          return new Response(await Deno.readFile(source), {
            headers: { "content-type": type },
          });
        } catch (error) {
          let status = 500;
          if (error instanceof Deno.errors.NotFound) status = 404;
          return new Response(String(error), { status });
        }
      },
    );
  } catch (error) {
    watcher?.close();
    await watching;
    await Deno.remove(temporary, { recursive: true });
    throw error;
  }
  return {
    server,
    invalidate,
    temporary,
    get bundleCount() {
      return serial;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      watcher?.close();
      abort.abort();
      await Promise.all([server.shutdown(), watching]);
      await Deno.remove(temporary, { recursive: true });
    },
  };
}
