import type { ShaderModuleId } from "./identity.ts";
import type { ComposedShaderSource } from "./model.ts";

export interface GeneratedShaderDiagnostic {
  readonly severity: "error" | "warning" | "info";
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

export interface ShaderDiagnostic extends GeneratedShaderDiagnostic {
  readonly module?: ShaderModuleId;
  readonly generated_line: number;
}

export function map_shader_diagnostics(
  source: ComposedShaderSource,
  diagnostics: readonly GeneratedShaderDiagnostic[],
): readonly ShaderDiagnostic[] {
  return Object.freeze(diagnostics.map((diagnostic, index) => {
    if (!["error", "warning", "info"].includes(diagnostic.severity)) {
      throw new Error(
        `shader diagnostic ${index} severity ${
          JSON.stringify(diagnostic.severity)
        } is unsupported`,
      );
    }
    if (!Number.isSafeInteger(diagnostic.line) || diagnostic.line <= 0) {
      throw new Error(
        `shader diagnostic ${index} line ${
          JSON.stringify(diagnostic.line)
        } must be positive`,
      );
    }
    if (!Number.isSafeInteger(diagnostic.column) || diagnostic.column <= 0) {
      throw new Error(
        `shader diagnostic ${index} column ${
          JSON.stringify(diagnostic.column)
        } must be positive`,
      );
    }
    if (typeof diagnostic.message !== "string") {
      throw new Error(`shader diagnostic ${index} message must be a string`);
    }
    const message = diagnostic.message.trim();
    if (message.length === 0) {
      throw new Error(`shader diagnostic ${index} message cannot be empty`);
    }
    const segment = source.source_map.find((candidate) =>
      diagnostic.line >= candidate.generated_start_line &&
      diagnostic.line <= candidate.generated_end_line
    );
    return Object.freeze({
      severity: diagnostic.severity,
      line: segment === undefined
        ? diagnostic.line
        : segment.source_start_line + diagnostic.line -
          segment.generated_start_line,
      column: diagnostic.column,
      message,
      generated_line: diagnostic.line,
      ...(segment === undefined ? {} : { module: segment.module }),
    });
  }));
}
