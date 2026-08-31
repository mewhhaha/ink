import { map_shader_diagnostics } from "@ink/shaders/diagnostics.ts";
import type { ComposedShaderSource } from "@ink/shaders/compose.ts";

export interface ShaderCompilationDiagnostic {
  readonly lineNum: number;
  readonly linePos: number;
  readonly message: string;
}

export function format_shader_compilation_diagnostic(
  source: ComposedShaderSource,
  diagnostic: ShaderCompilationDiagnostic,
): string {
  if (diagnostic.lineNum <= 0 || diagnostic.linePos <= 0) {
    return `generated WGSL ${diagnostic.lineNum}:${diagnostic.linePos}: ${diagnostic.message}`;
  }
  const [mapped] = map_shader_diagnostics(source, [{
    severity: "error",
    line: diagnostic.lineNum,
    column: diagnostic.linePos,
    message: diagnostic.message,
  }]);
  const location = mapped.module === undefined
    ? "generated WGSL"
    : mapped.module;
  return `${location} ${mapped.line}:${mapped.column}: ${mapped.message}`;
}
