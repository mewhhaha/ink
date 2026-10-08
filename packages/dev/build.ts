import { build as viteBuild } from "vite";
import { dirname, join, relative, resolve } from "@std/path";
import { createGameCompiler, formatDiagnostic } from "@ink/blot/compiler";
import { type SceneFile, sceneToWorld } from "@ink/schema";
import { scanAssets } from "./catalog.ts";
import { exists, loadSchema, type ResolvedProject } from "./node.ts";
import { checkName } from "./paths.ts";

export interface BuildResult {
  out: string;
  bytes: number;
  assetBytes: number;
  files: { path: string; bytes: number; sha256: string }[];
}

async function copyAssets(source: string, target: string) {
  if (!await exists(source)) return;
  await Deno.mkdir(target, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    if (entry.name.startsWith(".")) continue;
    const from = join(source, entry.name), to = join(target, entry.name);
    if (entry.isSymlink) {
      throw new Error(`Asset symlinks are not portable: ${from}`);
    }
    if (entry.isDirectory) await copyAssets(from, to);
    else if (entry.isFile) await Deno.copyFile(from, to);
  }
}

async function inventory(root: string): Promise<BuildResult["files"]> {
  const files: BuildResult["files"] = [];
  const walk = async (dir: string) => {
    for await (const entry of Deno.readDir(dir)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory) await walk(path);
      else {
        const bytes = await Deno.readFile(path);
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        files.push({
          path: relative(root, path).replaceAll("\\", "/"),
          bytes: bytes.length,
          sha256: [...new Uint8Array(digest)].map((b) =>
            b.toString(16).padStart(2, "0")
          ).join(""),
        });
      }
    }
  };
  await walk(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Compile and bundle into staging; replace only an identified Ink build. */
export async function buildPlayer(
  project: ResolvedProject,
  options: { out?: string; scene?: string } = {},
): Promise<BuildResult> {
  const out = resolve(options.out ?? join(project.dir, "dist"));
  if (out === project.assetsDir || out.startsWith(project.assetsDir + "/")) {
    throw new Error(
      "Build output cannot be inside the source assets directory",
    );
  }
  if (out === project.dir || project.dir.startsWith(out + "/")) {
    throw new Error("Build output cannot replace the project or its parents");
  }
  if (await exists(out)) {
    const marker = join(out, "ink-build.json");
    if (
      !await exists(marker) ||
      JSON.parse(await Deno.readTextFile(marker)).inkBuild !== 1
    ) {
      throw new Error(
        `Refusing to replace a directory without an Ink build manifest: ${out}`,
      );
    }
  }
  const schema = await loadSchema(project.schemaPath, Date.now());
  const catalog = await scanAssets(project.assetsDir);
  const sceneName = checkName(
    options.scene ?? project.config.player?.scene ?? "main",
  );
  const scene = JSON.parse(
    await Deno.readTextFile(join(project.scenesDir, `${sceneName}.scene.json`)),
  ) as SceneFile;
  const loaded = sceneToWorld(schema, scene, catalog);
  if (loaded.problems.length) throw new Error(loaded.problems.join("\n"));
  const compiler = await createGameCompiler({
    entry: project.gamePath,
    schema,
    catalog,
  });
  let source: string | undefined;
  let stage: string | undefined;
  try {
    const game = await compiler.build();
    if (!game.ok) {
      throw new Error(game.diagnostics.map(formatDiagnostic).join("\n"));
    }
    await Deno.mkdir(project.inkDir, { recursive: true });
    await Deno.mkdir(dirname(out), { recursive: true });
    source = await Deno.makeTempDir({
      dir: project.inkDir,
      prefix: "player-source-",
    });
    stage = await Deno.makeTempDir({
      dir: dirname(out),
      prefix: ".ink-player-",
    });
    await Deno.writeFile(join(source, "game.wasm"), game.bytes);
    const title = project.title.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
      .replaceAll('"', "&quot;");
    await Deno.writeTextFile(
      join(source, "index.html"),
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${title}</title></head><body><script type="module" src="./entry.ts"></script></body></html>`,
    );
    await Deno.writeTextFile(
      join(source, "entry.ts"),
      `
import { bootPlayer } from "@ink/player";
import schema from ${JSON.stringify(project.schemaPath)};
import wasm from "./game.wasm?url";
const ready = bootPlayer({ ...${
        JSON.stringify(project.config.player ?? {})
      }, title: ${JSON.stringify(project.title)}, schema, catalog: ${
        JSON.stringify(catalog)
      }, wasm, scene: new URL("./scene.json", document.baseURI).href, assetBase: new URL("./assets/", document.baseURI).href });
if (new URL(location.href).searchParams.has("ink-automation")) globalThis.__inkPlayer = ready;
ready.catch((error) => console.error(error));
`,
    );
    await viteBuild({
      root: source,
      configFile: false,
      base: "./",
      logLevel: "warn",
      publicDir: false,
      plugins: [{
        name: "ink-player-resolve",
        enforce: "pre",
        resolveId(id) {
          if (id.startsWith("@ink/") || id.startsWith("@mewhhaha/blot")) {
            const url = import.meta.resolve(id);
            if (url.startsWith("file:")) return new URL(url).pathname;
          }
        },
        generateBundle(_options, bundle) {
          for (const output of Object.values(bundle)) {
            if (output.type !== "chunk") continue;
            const editor = Object.keys(output.modules).find((id) =>
              /packages\/(react|dev)\/|react-dom|packages\/core\/session\.ts/
                .test(id)
            );
            if (editor) {
              throw new Error(
                `Editor code leaked into the shipping player: ${editor}`,
              );
            }
          }
        },
      }],
      build: {
        outDir: stage,
        emptyOutDir: true,
        assetsDir: "runtime",
        assetsInlineLimit: 0,
        sourcemap: false,
        target: "es2022",
      },
    });
    await Deno.writeTextFile(join(stage, "scene.json"), JSON.stringify(scene));
    await copyAssets(project.assetsDir, join(stage, "assets"));
    const files = await inventory(stage);
    const bytes = files.filter((f) => !f.path.startsWith("assets/")).reduce(
      (n, f) => n + f.bytes,
      0,
    );
    const assetBytes = files.filter((f) => f.path.startsWith("assets/")).reduce(
      (n, f) => n + f.bytes,
      0,
    );
    await Deno.writeTextFile(
      join(stage, "ink-build.json"),
      JSON.stringify(
        {
          inkBuild: 1,
          title: project.title,
          scene: sceneName,
          bytes,
          assetBytes,
          files,
        },
        null,
        2,
      ),
    );
    const backup = `${out}.previous-${crypto.randomUUID()}`;
    const replacing = await exists(out);
    if (replacing) await Deno.rename(out, backup);
    try {
      await Deno.rename(stage, out);
      stage = undefined;
    } catch (error) {
      if (replacing) await Deno.rename(backup, out);
      throw error;
    }
    if (replacing) await Deno.remove(backup, { recursive: true });
    return { out, bytes, assetBytes, files };
  } finally {
    await compiler.dispose();
    if (source) await Deno.remove(source, { recursive: true });
    if (stage) await Deno.remove(stage, { recursive: true });
  }
}
