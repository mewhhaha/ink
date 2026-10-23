import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { revision } from "./toolchain.ts";
import { sealCache, validCache } from "./cache.ts";

// The supported frontend reads its lexer artifacts through file URLs. Keep the
// exact upstream sources and artifacts locally; do not substitute a parser.
const files = [
  "compiler/derive.ts",
  "compiler/syntax.ts",
  "compiler/parser_source.ts",
  "compiler/numeric_parser.ts",
  "compiler/postfix_syntax.ts",
  "generated/wasm/mod.ts",
  "generated/wasm/syntax.ts",
  "generated/wasm/cst-schema.json",
  "generated/wasm/parser.wasm",
  "generated/wasm/parser.plan",
];
export async function derivation(): Promise<
  typeof import("@mewhhaha/blot/derive")
> {
  const root = new URL(`../.cache/derive-${revision}/`, import.meta.url);
  if (!await validCache(root, revision, files).catch(() => false)) {
    for (const file of files) {
      const response = await fetch(
        `https://raw.githubusercontent.com/mewhhaha/blot2/${revision}/${file}`,
      );
      if (!response.ok) {
        throw new Error(
          `Cannot fetch derivation artifact ${file}: ${response.status}`,
        );
      }
      const destination = new URL(file, root);
      await Deno.mkdir(dirname(fileURLToPath(destination)), {
        recursive: true,
      });
      await Deno.writeFile(
        destination,
        new Uint8Array(await response.arrayBuffer()),
      );
    }
    await sealCache(root, revision, files);
  }
  return await import(new URL("compiler/derive.ts", root).href);
}
