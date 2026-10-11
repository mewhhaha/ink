import { cpus } from "node:os";

/** The import map is the single compiler pin; runtime versions are recorded on demand. */
const configUrl = new URL("../deno.json", import.meta.url);
const config = JSON.parse(await Deno.readTextFile(configUrl));
const compilerUrl = new URL(config.imports["@mewhhaha/blot"]);
const match = compilerUrl.pathname.match(
  /^\/mewhhaha\/blot2\/([a-f0-9]{40})\/mod\.ts$/,
);
if (!match) {
  throw new Error(
    "Pin @mewhhaha/blot to an exact upstream commit in deno.json",
  );
}
export const revision = match[1];
if (
  config.imports["@mewhhaha/blot/guest"] &&
  config.imports["@mewhhaha/blot/guest"] !==
    new URL("compiler/guest.ts", compilerUrl).href
) {
  throw new Error("Blot compiler and guest imports must use the same revision");
}

export function toolchain() {
  return {
    compilerRevision: revision,
    deno: Deno.version.deno,
    v8: Deno.version.v8,
    typescript: Deno.version.typescript,
    target: `${Deno.build.os}-${Deno.build.arch}`,
    hardwareConcurrency: navigator.hardwareConcurrency,
    cpu: cpus()[0]?.model,
  };
}

if (import.meta.main) {
  if (Deno.args[0] === "update") {
    const next = Deno.args[1];
    if (!next || !/^[a-f0-9]{40}$/.test(next)) {
      throw new Error("Use toolchain.ts update <40-character compiler commit>");
    }
    const base = `https://raw.githubusercontent.com/mewhhaha/blot2/${next}/`;
    config.imports["@mewhhaha/blot"] = `${base}mod.ts`;
    if (config.imports["@mewhhaha/blot/guest"]) {
      config.imports["@mewhhaha/blot/guest"] = `${base}compiler/guest.ts`;
    }
    await Deno.writeTextFile(configUrl, `${JSON.stringify(config, null, 2)}\n`);
    console.log(
      "Compiler pin updated. Run deno task setup and deno task test before accepting the update.",
    );
  } else {
    const report = toolchain();
    await Deno.mkdir(new URL("../.cache/", import.meta.url), {
      recursive: true,
    });
    await Deno.writeTextFile(
      new URL("../.cache/toolchain.json", import.meta.url),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    console.log(JSON.stringify(report, null, 2));
  }
}
