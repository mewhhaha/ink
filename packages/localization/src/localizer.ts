import {
  locale_id,
  type LocalizationCatalog,
  message_id,
  type MessageParameter,
  type MessageParameters,
  type MessagePart,
  type MessagePattern,
} from "./catalog.ts";

export interface LocalizationResolver {
  resolve(message: string, parameters: MessageParameters): string;
}

export type LocalizationResult =
  | {
    readonly type: "resolved";
    readonly value: string;
    readonly locale: string;
  }
  | {
    readonly type: "missing";
    readonly message: string;
    readonly attempted_locales: readonly string[];
  }
  | {
    readonly type: "failed";
    readonly message: string;
    readonly locale: string;
    readonly reason: string;
  };

export interface LocalizerOptions {
  readonly catalogs: readonly LocalizationCatalog[];
  readonly locale: string;
  readonly fallback_locales?: readonly string[];
}

export class Localizer implements LocalizationResolver {
  readonly #catalogs: ReadonlyMap<string, LocalizationCatalog>;
  readonly #locales: readonly string[];

  constructor(options: LocalizerOptions) {
    const catalogs = new Map<string, LocalizationCatalog>();
    for (const catalog of options.catalogs) {
      const locale = locale_id(catalog.locale);
      if (catalogs.has(locale)) {
        throw new Error(`localizer repeats catalog ${locale}`);
      }
      catalogs.set(
        locale,
        Object.freeze({
          locale,
          messages: new Map(catalog.messages),
        }),
      );
    }
    if (catalogs.size === 0) {
      throw new Error("localizer requires at least one catalog");
    }
    this.#catalogs = catalogs;
    this.#locales = Object.freeze(locale_chain(
      options.locale,
      options.fallback_locales ?? [],
    ));
  }

  get locales(): readonly string[] {
    return this.#locales;
  }

  try_resolve(
    message: string,
    parameters: MessageParameters,
  ): LocalizationResult {
    const id = message_id(message);
    for (const locale of this.#locales) {
      const pattern = this.#catalogs.get(locale)?.messages.get(id);
      if (pattern === undefined) continue;
      try {
        const value = format_pattern(pattern, parameters, locale, id);
        if (value.length === 0) {
          return {
            type: "failed",
            message: id,
            locale,
            reason: "formatted text is empty",
          };
        }
        return { type: "resolved", value, locale };
      } catch (error) {
        return {
          type: "failed",
          message: id,
          locale,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return {
      type: "missing",
      message: id,
      attempted_locales: this.#locales,
    };
  }

  resolve(message: string, parameters: MessageParameters): string {
    const result = this.try_resolve(message, parameters);
    if (result.type === "resolved") return result.value;
    if (result.type === "missing") {
      throw new Error(
        `localization message ${
          JSON.stringify(result.message)
        } is missing from locales ${result.attempted_locales.join(", ")}`,
      );
    }
    throw new Error(
      `localization message ${
        JSON.stringify(result.message)
      } in ${result.locale} failed: ${result.reason}`,
    );
  }
}

export function locale_chain(
  preferred_locale: string,
  fallback_locales: readonly string[],
): readonly string[] {
  const locales: string[] = [];
  for (const candidate of [preferred_locale, ...fallback_locales]) {
    const canonical = locale_id(candidate);
    const parts = canonical.split("-");
    while (parts.length > 0) {
      const fallback = parts.join("-");
      if (!locales.includes(fallback)) locales.push(fallback);
      parts.pop();
    }
  }
  return Object.freeze(locales);
}

function format_pattern(
  pattern: MessagePattern,
  parameters: MessageParameters,
  locale: string,
  message: string,
): string {
  return pattern.map((part) => format_part(part, parameters, locale, message))
    .join("");
}

function format_part(
  part: MessagePart,
  parameters: MessageParameters,
  locale: string,
  message: string,
): string {
  if (part.type === "text") return part.value;
  const parameter = require_parameter(parameters, part.name, message);
  if (part.type === "parameter") {
    return format_parameter(part, parameter, locale, message);
  }
  if (part.type === "select") {
    if (parameter instanceof Date) {
      throw new Error(
        `select argument ${JSON.stringify(part.name)} cannot be a date`,
      );
    }
    const selected = part.cases[String(parameter)] ?? part.cases.other;
    return format_pattern(selected, parameters, locale, message);
  }
  if (typeof parameter !== "number" || !Number.isFinite(parameter)) {
    throw new Error(
      `plural argument ${JSON.stringify(part.name)} must be a finite number`,
    );
  }
  const exact = part.cases[`=${parameter}`];
  const category = new Intl.PluralRules(locale, {
    type: part.rule ?? "cardinal",
  }).select(parameter);
  return format_pattern(
    exact ?? part.cases[category] ?? part.cases.other,
    parameters,
    locale,
    message,
  );
}

function format_parameter(
  part: Extract<MessagePart, { readonly type: "parameter" }>,
  parameter: MessageParameter,
  locale: string,
  message: string,
): string {
  if (part.format === undefined) {
    return parameter instanceof Date
      ? parameter.toISOString()
      : String(parameter);
  }
  if (part.format.type === "number") {
    if (typeof parameter !== "number" || !Number.isFinite(parameter)) {
      throw new Error(
        `message ${message} argument ${
          JSON.stringify(part.name)
        } must be a finite number`,
      );
    }
    return new Intl.NumberFormat(locale, part.format.options).format(parameter);
  }
  if (!(parameter instanceof Date) && typeof parameter !== "number") {
    throw new Error(
      `message ${message} argument ${
        JSON.stringify(part.name)
      } must be a date or timestamp`,
    );
  }
  const date = parameter instanceof Date ? parameter : new Date(parameter);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(
      `message ${message} argument ${
        JSON.stringify(part.name)
      } is an invalid date`,
    );
  }
  const options = part.format.options ??
    (part.format.type === "time"
      ? { hour: "numeric", minute: "2-digit" }
      : { year: "numeric", month: "short", day: "numeric" });
  return new Intl.DateTimeFormat(locale, options).format(date);
}

function require_parameter(
  parameters: MessageParameters,
  name: string,
  message: string,
): MessageParameter {
  const value = parameters[name];
  if (value === undefined) {
    throw new Error(
      `message ${message} requires argument ${JSON.stringify(name)}`,
    );
  }
  return value;
}
