import type { UiText } from "./semantic.ts";

export interface LocalizationResolver {
  resolve(
    message: string,
    parameters: Readonly<Record<string, string | number | boolean>>,
  ): string;
}

export type ResolvedTextResult =
  | { readonly type: "resolved"; readonly value: string }
  | {
    readonly type: "failed";
    readonly message: string;
    readonly reason: string;
  };

export function resolve_ui_text(
  text: UiText,
  resolver: LocalizationResolver,
): ResolvedTextResult {
  if (text.type === "literal") return { type: "resolved", value: text.value };
  try {
    const value = resolver.resolve(text.id, text.parameters);
    if (value.trim().length === 0) {
      return {
        type: "failed",
        message: text.id,
        reason: "resolver returned empty text",
      };
    }
    return { type: "resolved", value };
  } catch (error) {
    return {
      type: "failed",
      message: text.id,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function require_ui_text(
  text: UiText,
  resolver: LocalizationResolver,
): string {
  const result = resolve_ui_text(text, resolver);
  if (result.type === "failed") {
    throw new Error(
      `localization message ${
        JSON.stringify(result.message)
      } failed: ${result.reason}`,
    );
  }
  return result.value;
}
