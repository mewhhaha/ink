/**
 * Compiles a game: writes the generated schema module next to the entry and
 * keeps one Blot compiler session open so edits reuse unchanged work.
 * Deno only — the Blot compiler runs as a native child process.
 */
import { createCompiler, type ZigProjectCompiler } from "@mewhhaha/blot";
import {
  type Catalog,
  generateBlot,
  generateTypeScript,
  type Schema,
} from "@ink/schema";
import { dirname, fromFileUrl, join } from "@std/path";
import { libraryUrl } from "./mod.ts";

export interface Diagnostic {
  file: string;
  /** 1-based line and column of the span start. */
  line: number;
  column: number;
  code: string;
  message: string;
  /** The source line the span starts on. */
  excerpt: string;
}

export type BuildResult =
  | { ok: true; bytes: Uint8Array; revision: number; ms: number }
  | { ok: false; diagnostics: Diagnostic[]; ms: number };

export interface GameCompiler {
  /** The generated module's path, e.g. `game/schema.gen.blot`. */
  readonly generatedPath: string;
  readonly generatedTypeScriptPath: string;
  /** Regenerate the schema module (when the schema or catalog changed). */
  generate(schema: Schema, catalog: Catalog): Promise<boolean>;
  build(sources?: Record<string, string>): Promise<BuildResult>;
  dispose(): Promise<void>;
}

export interface GameCompilerOptions {
  /** Absolute path of the game's entry module, e.g. `/p/game/main.blot`. */
  entry: string;
  schema: Schema;
  catalog: Catalog;
}

export async function createGameCompiler(
  options: GameCompilerOptions,
): Promise<GameCompiler> {
  const generatedPath = join(dirname(options.entry), "schema.gen.blot");
  const generatedTypeScriptPath = join(dirname(options.entry), "schema.gen.ts");
  let generated = "";
  const generate = async (schema: Schema, catalog: Catalog) => {
    const text = generateBlot(schema, catalog);
    const types = generateTypeScript(schema);
    let currentTypes = "";
    try {
      currentTypes = await Deno.readTextFile(generatedTypeScriptPath);
    } catch { /* first generation */ }
    if (currentTypes !== types) {
      await Deno.writeTextFile(generatedTypeScriptPath, types);
    }
    if (text === generated) return false;
    generated = text;
    let current = "";
    try {
      current = await Deno.readTextFile(generatedPath);
    } catch {
      // first generation
    }
    if (current !== text) await Deno.writeTextFile(generatedPath, text);
    return true;
  };
  await generate(options.schema, options.catalog);
  let compiler: ZigProjectCompiler = await open();
  let queue: Promise<unknown> = Promise.resolve();

  function open() {
    return createCompiler({
      entry: options.entry,
      imports: { "ink/": fromFileUrl(libraryUrl) },
    });
  }

  const build = (sources?: Record<string, string>): Promise<BuildResult> => {
    const run = queue.then(async (): Promise<BuildResult> => {
      const started = performance.now();
      let result;
      try {
        result = await compiler.build(sources ? { sources } : undefined);
      } catch (error) {
        // A crashed compiler process: start a fresh session and retry once.
        await compiler.dispose().catch(() => {});
        compiler = await open();
        try {
          result = await compiler.build(sources ? { sources } : undefined);
        } catch {
          return {
            ok: false,
            ms: performance.now() - started,
            diagnostics: [{
              file: options.entry,
              line: 1,
              column: 1,
              code: "compiler_crash",
              message: String(error),
              excerpt: "",
            }],
          };
        }
      }
      const ms = performance.now() - started;
      if (result.success) {
        return { ok: true, bytes: result.bytes, revision: result.revision, ms };
      }
      return {
        ok: false,
        ms,
        diagnostics: await Promise.all(
          result.diagnostics.map((d) => locate(d, sources)),
        ),
      };
    });
    queue = run.catch(() => {});
    return run;
  };

  return {
    generatedPath,
    generatedTypeScriptPath,
    generate,
    build,
    async dispose() {
      await queue;
      await compiler.dispose();
    },
  };
}

const sourceCache = new Map<string, string>();

async function locate(
  d: { filename: string; start: number; code: string; message: string },
  sources?: Record<string, string>,
): Promise<Diagnostic> {
  let text = sources?.[d.filename];
  if (text === undefined) {
    try {
      text = await Deno.readTextFile(d.filename);
      sourceCache.set(d.filename, text);
    } catch {
      text = sourceCache.get(d.filename) ?? "";
    }
  }
  const bytes = new TextEncoder().encode(text);
  const before = new TextDecoder().decode(bytes.slice(0, d.start));
  const lines = before.split("\n");
  const line = lines.length;
  const column = lines[lines.length - 1].length + 1;
  return {
    file: d.filename,
    line,
    column,
    code: d.code,
    message: d.message,
    excerpt: text.split("\n")[line - 1] ?? "",
  };
}

export function formatDiagnostic(d: Diagnostic): string {
  return `${d.file}:${d.line}:${d.column}: ${d.code}: ${d.message}\n    ${d.excerpt.trim()}`;
}
