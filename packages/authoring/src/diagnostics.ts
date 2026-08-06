export type AuthoringDiagnosticSeverity = "error" | "warning" | "suggestion";

export interface AuthoringDiagnostic {
  readonly code: string;
  readonly severity: AuthoringDiagnosticSeverity;
  readonly message: string;
  readonly subject?: string;
  readonly recovery?: string;
}

export function authoring_diagnostic(
  diagnostic: AuthoringDiagnostic,
): AuthoringDiagnostic {
  const code = diagnostic.code.trim();
  const message = diagnostic.message.trim();
  if (!/^[A-Z][A-Z0-9_]+$/.test(code)) {
    throw new Error(
      `authoring diagnostic code ${
        JSON.stringify(diagnostic.code)
      } must use uppercase snake case`,
    );
  }
  if (message.length === 0) {
    throw new Error(`authoring diagnostic ${code} message cannot be empty`);
  }
  const subject = diagnostic.subject?.trim();
  const recovery = diagnostic.recovery?.trim();
  return Object.freeze({
    code,
    severity: diagnostic.severity,
    message,
    ...(subject === undefined || subject.length === 0 ? {} : { subject }),
    ...(recovery === undefined || recovery.length === 0 ? {} : { recovery }),
  });
}

export function has_authoring_errors(
  diagnostics: readonly AuthoringDiagnostic[],
): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}
