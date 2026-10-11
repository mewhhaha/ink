/** Local lanes include Blot's filesystem imports, which Deno's graph cannot see. */
import { setup } from "./setup.ts";
import { setupBrowser } from "./browser.ts";

const project = new URL("../", import.meta.url);
const manifest: { name: string; exports: Record<string, string> } = JSON.parse(
  await Deno.readTextFile(new URL("deno.json", project)),
);
const browserTests = new Set([
  "tests/browser-adapters_test.ts",
  "tests/browser-tooling_test.ts",
  "tests/gpu_test.ts",
  "tests/gpu_maintenance_test.ts",
  "tests/gpu_parity_test.ts",
  "tests/distribution_test.ts",
]);
const wholePackageTests = new Set([
  "tests/distribution_test.ts",
  "tests/package_test.ts",
  "tests/integration_test.ts",
]);

export async function testFiles(root = project): Promise<string[]> {
  const files = [];
  for await (const item of Deno.readDir(new URL("tests/", root))) {
    if (item.isFile && item.name.endsWith("_test.ts")) {
      files.push(`tests/${item.name}`);
    }
  }
  return files.sort();
}

export async function dependencies(
  file: string,
  root = project,
  found = new Set<string>(),
): Promise<Set<string>> {
  if (found.has(file)) return found;
  found.add(file);
  let source: string;
  try {
    source = await Deno.readTextFile(new URL(file, root));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return found;
    throw error;
  }
  for (
    const match of source.matchAll(
      /["']((?:\.\.?\/|\/(?:tests|examples|shaders)\/|ink\/|@)[^"'\n]+)["']/g,
    )
  ) {
    const reference = match[1];
    let target: URL | undefined;
    if (reference.startsWith("ink/")) {
      target = new URL(`lib/${reference.slice(4)}.blot`, root);
    } else if (reference.startsWith("./") || reference.startsWith("../")) {
      target = new URL(reference, new URL(file, root));
      if (file.endsWith(".blot") && !target.pathname.endsWith(".blot")) {
        target = new URL(`${target.href}.blot`);
      }
    } else if (
      reference === manifest.name || reference.startsWith(`${manifest.name}/`)
    ) {
      const exported =
        manifest.exports["." + reference.slice(manifest.name.length)];
      if (exported) target = new URL(exported, root);
    } else if (
      reference.startsWith("/tests/") || reference.startsWith("/examples/") ||
      reference.startsWith("/shaders/")
    ) target = new URL(reference.slice(1), root);
    if (
      !target || !/\.(?:ts|blot|html|wgsl)$/.test(target.pathname) ||
      !target.href.startsWith(root.href)
    ) continue;
    const relative = decodeURIComponent(target.href.slice(root.href.length));
    await dependencies(relative, root, found);
  }
  return found;
}

export async function affectedTests(
  changed: string[],
  files: string[],
  root = project,
) {
  const global = changed.some((file) =>
    ["deno.json", "deno.lock", "mod.ts", "tools/setup.ts", "tools/toolchain.ts"]
      .includes(file)
  );
  if (global) return files;
  const selected = [];
  for (const file of files) {
    if (
      wholePackageTests.has(file) &&
      changed.some((path) => /^(?:lib|adapters|shaders|examples)\//.test(path))
    ) {
      selected.push(file);
      continue;
    }
    const graph = await dependencies(file, root);
    const shaderConsumer = graph.has("adapters/gpu.ts") &&
      changed.some((path) => path.startsWith("shaders/"));
    if (shaderConsumer || changed.some((path) => graph.has(path))) {
      selected.push(file);
    }
  }
  return selected;
}

export async function selectTests(
  lane: string,
  changed: string[] = [],
  root = project,
) {
  const files = await testFiles(root);
  if (lane === "browser") return files.filter((file) => browserTests.has(file));
  if (lane === "affected") {
    const selected = await affectedTests(changed, files, root);
    // Ordinary source edits use numerical/DOM witnesses; packaging has its own lane.
    if (
      changed.every((path) => /^(?:lib|adapters|shaders|examples)\//.test(path))
    ) {
      return selected.filter((file) => file !== "tests/distribution_test.ts");
    }
    return selected;
  }
  if (lane === "integration") {
    return files.filter((file) => wholePackageTests.has(file));
  }
  if (lane === "fast") {
    const selected = [];
    for (const file of files) {
      if (browserTests.has(file) || wholePackageTests.has(file)) continue;
      const source = await Deno.readTextFile(new URL(file, root));
      const names = Array.from(
        source.matchAll(/Deno\.test\(\s*["']([^"']+)["']/g),
        (match) => match[1],
      );
      if (
        names.length > 0 && names.every((name) => name.includes("[stress]"))
      ) continue;
      selected.push(file);
    }
    return selected;
  }
  if (lane === "stress") {
    const selected = [];
    for (const file of files) {
      const source = await Deno.readTextFile(new URL(file, root));
      if (source.includes("[stress]")) selected.push(file);
    }
    return selected;
  }
  throw new Error(
    "Use test.ts fast|browser|stress|integration|affected [changed paths] [--list]",
  );
}

if (import.meta.main) {
  const started = performance.now();
  const lane = Deno.args[0] ?? "fast";
  let changed = Deno.args.slice(1).filter((arg) => arg !== "--list");
  if (lane === "affected" && changed.length === 0) {
    const results = await Promise.all([
      new Deno.Command("git", {
        args: ["diff", "--name-only", "HEAD"],
        stdout: "piped",
      }).output(),
      new Deno.Command("git", {
        args: ["ls-files", "--others", "--exclude-standard"],
        stdout: "piped",
      }).output(),
    ]);
    changed = [];
    for (const result of results) {
      if (!result.success) {
        throw new Error("Cannot read changed paths; supply paths explicitly");
      }
      changed.push(
        ...new TextDecoder().decode(result.stdout).trim().split("\n").filter(
          Boolean,
        ),
      );
    }
  }
  changed = changed.map((path) => path.replace(/^\.\//, ""));
  const files = await selectTests(lane, changed);
  if (Deno.args.includes("--list")) {
    console.log(files.join("\n"));
  } else if (files.length === 0) {
    console.log("No tests selected.");
  } else {
    await setup();
    if (files.some((file) => browserTests.has(file))) await setupBrowser();
    const args = ["test", "-A", "--no-check", "--parallel"];
    if (lane === "stress") args.push("--filter", "[stress]");
    if (lane === "fast" || lane === "affected") {
      args.push("--filter", "/^[^\\[]/");
    }
    args.push(...files);
    const result = await new Deno.Command(Deno.execPath(), {
      args,
      stdout: "inherit",
      stderr: "inherit",
    }).output();
    console.log(
      `${lane} lane: ${((performance.now() - started) / 1000).toFixed(3)}s`,
    );
    Deno.exitCode = result.code;
  }
}
