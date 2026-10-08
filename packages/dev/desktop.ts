import { cp } from "node:fs/promises";
import { dirname, join, resolve } from "@std/path";
import { exists, type ResolvedProject } from "./node.ts";

/** Bundle the static build and Electron for the current desktop OS. */
export async function packageDesktop(
  project: ResolvedProject,
  web: string,
  output = join(project.dir, "dist-desktop"),
): Promise<string[]> {
  const platform = Deno.build.os === "windows"
    ? "win32"
    : Deno.build.os === "darwin"
    ? "darwin"
    : "linux";
  const arch = Deno.build.arch === "aarch64" ? "arm64" : "x64";
  const out = resolve(output);
  if (out === resolve(web) || out.startsWith(resolve(web) + "/")) {
    throw new Error("Desktop output must be outside the static build");
  }
  if (out === project.dir || project.dir.startsWith(out + "/")) {
    throw new Error("Desktop output cannot replace the project or its parents");
  }
  if (
    await exists(out) &&
    (!await exists(join(out, "ink-desktop.json")) ||
      JSON.parse(await Deno.readTextFile(join(out, "ink-desktop.json")))
          .inkDesktop !== 1)
  ) {
    throw new Error(
      `Refusing to replace a directory without an Ink desktop manifest: ${out}`,
    );
  }
  await Deno.mkdir(project.inkDir, { recursive: true });
  await Deno.mkdir(dirname(out), { recursive: true });
  const source = await Deno.makeTempDir({
    dir: project.inkDir,
    prefix: "desktop-source-",
  });
  const stage = await Deno.makeTempDir({
    dir: dirname(out),
    prefix: ".ink-desktop-",
  });
  let installed = false;
  try {
    await cp(web, join(source, "web"), { recursive: true });
    await Deno.writeTextFile(
      join(source, "package.json"),
      JSON.stringify({
        name: "ink-game",
        productName: project.title,
        version: "1.0.0",
        main: "main.cjs",
        private: true,
      }),
    );
    await Deno.copyFile(
      new URL("../player/desktop.cjs", import.meta.url),
      join(source, "main.cjs"),
    );
    const { packager } = await import("@electron/packager");
    const targets = await packager({
      dir: source,
      out: stage,
      name: "ink-game",
      executableName: "ink-game",
      appVersion: "1.0.0",
      electronVersion: "44.7.0",
      platform,
      arch,
      asar: true,
      prune: false,
      quiet: true,
      download: { cacheRoot: join(project.inkDir, "electron-cache") },
    });
    const paths = targets.map((p) => p.slice(stage.length + 1));
    await Deno.writeTextFile(
      join(stage, "ink-desktop.json"),
      JSON.stringify(
        {
          inkDesktop: 1,
          title: project.title,
          electron: "44.7.0",
          platform,
          arch,
          paths,
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
      installed = true;
    } catch (error) {
      if (replacing) await Deno.rename(backup, out);
      throw error;
    }
    if (replacing) await Deno.remove(backup, { recursive: true });
    return paths.map((p) => join(out, p));
  } finally {
    await Deno.remove(source, { recursive: true });
    if (!installed) await Deno.remove(stage, { recursive: true });
  }
}
