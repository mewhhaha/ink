export type MessageParameter = string | number | boolean | Date;
export type MessageParameters = Readonly<Record<string, MessageParameter>>;

export type MessagePart =
  | { readonly type: "text"; readonly value: string }
  | {
    readonly type: "parameter";
    readonly name: string;
    readonly format?:
      | { readonly type: "number"; readonly options?: Intl.NumberFormatOptions }
      | { readonly type: "date"; readonly options?: Intl.DateTimeFormatOptions }
      | {
        readonly type: "time";
        readonly options?: Intl.DateTimeFormatOptions;
      };
  }
  | {
    readonly type: "select";
    readonly name: string;
    readonly cases: Readonly<Record<string, MessagePattern>>;
  }
  | {
    readonly type: "plural";
    readonly name: string;
    readonly rule?: "cardinal" | "ordinal";
    readonly cases: Readonly<Record<string, MessagePattern>>;
  };

export type MessagePattern = readonly MessagePart[];

export interface LocalizationCatalogSource {
  readonly locale: string;
  readonly messages: Readonly<Record<string, MessagePattern>>;
}

export interface LocalizationCatalog {
  readonly locale: string;
  readonly messages: ReadonlyMap<string, MessagePattern>;
}

export function locale_id(value: string): string {
  try {
    const canonical = Intl.getCanonicalLocales(value.trim())[0];
    if (canonical === undefined) throw new Error("locale is empty");
    return canonical;
  } catch (error) {
    throw new Error(
      `locale ${JSON.stringify(value)} is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function message_id(value: string): string {
  const parsed = value.trim();
  if (parsed.length === 0 || !/^[a-zA-Z0-9_.:/-]+$/.test(parsed)) {
    throw new Error(
      `localization message id ${
        JSON.stringify(value)
      } must be nonempty and stable`,
    );
  }
  return parsed;
}

export function create_catalog(
  source: LocalizationCatalogSource,
): LocalizationCatalog {
  const locale = locale_id(source.locale);
  const messages = new Map<string, MessagePattern>();
  for (const [unparsed_id, pattern] of Object.entries(source.messages)) {
    const id = message_id(unparsed_id);
    if (messages.has(id)) {
      throw new Error(`localization catalog ${locale} repeats message ${id}`);
    }
    messages.set(id, parse_pattern(pattern, `${locale}:${id}`, 0));
  }
  if (messages.size === 0) {
    throw new Error(
      `localization catalog ${locale} requires at least one message`,
    );
  }
  return Object.freeze({ locale, messages });
}

function parse_pattern(
  pattern: MessagePattern,
  location: string,
  depth: number,
): MessagePattern {
  if (!Array.isArray(pattern) || pattern.length === 0) {
    throw new Error(
      `localization pattern ${location} requires at least one part`,
    );
  }
  if (depth > 32) {
    throw new Error(
      `localization pattern ${location} exceeds 32 nested selections`,
    );
  }
  return Object.freeze(pattern.map((part, index) => {
    const part_location = `${location}[${index}]`;
    if (typeof part !== "object" || part === null) {
      throw new Error(`localization part ${part_location} must be an object`);
    }
    const type = (part as { readonly type?: unknown }).type;
    if (
      type !== "text" && type !== "parameter" && type !== "select" &&
      type !== "plural"
    ) {
      throw new Error(
        `localization part ${part_location} type ${
          JSON.stringify(type)
        } is invalid`,
      );
    }
    if (part.type === "text") {
      if (typeof part.value !== "string" || part.value.length === 0) {
        throw new Error(`localization text ${part_location} cannot be empty`);
      }
      return Object.freeze({ type: "text", value: part.value });
    }
    if (typeof part.name !== "string") {
      throw new Error(
        `localization argument ${part_location} name must be a string`,
      );
    }
    const name = part.name.trim();
    if (name.length === 0) {
      throw new Error(
        `localization argument ${part_location} name cannot be empty`,
      );
    }
    if (part.type === "parameter") {
      return Object.freeze({
        type: "parameter",
        name,
        ...(part.format === undefined
          ? {}
          : { format: parse_parameter_format(part.format, part_location) }),
      });
    }
    if (
      typeof part.cases !== "object" || part.cases === null ||
      Array.isArray(part.cases)
    ) {
      throw new Error(
        `localization ${part.type} ${part_location} cases must be an object`,
      );
    }
    if (
      part.type === "plural" && part.rule !== undefined &&
      part.rule !== "cardinal" && part.rule !== "ordinal"
    ) {
      throw new Error(
        `localization plural ${part_location} rule ${
          JSON.stringify(part.rule)
        } is invalid`,
      );
    }
    const case_names = new Set<string>();
    const cases = Object.fromEntries(
      (Object.entries(part.cases) as [string, MessagePattern][]).map(
        ([source_key, value]) => {
          const key = source_key.trim();
          if (key.length === 0) {
            throw new Error(
              `localization ${part.type} ${part_location} has an empty case`,
            );
          }
          if (case_names.has(key)) {
            throw new Error(
              `localization ${part.type} ${part_location} repeats case ${
                JSON.stringify(key)
              }`,
            );
          }
          case_names.add(key);
          return [
            key,
            parse_pattern(value, `${part_location}.${key}`, depth + 1),
          ];
        },
      ),
    );
    if (!("other" in cases)) {
      throw new Error(
        `localization ${part.type} ${part_location} requires an other case`,
      );
    }
    return Object.freeze({
      type: part.type,
      name,
      ...(part.type === "plural" && part.rule !== undefined
        ? { rule: part.rule }
        : {}),
      cases: Object.freeze(cases),
    });
  }));
}

function parse_parameter_format(
  format: NonNullable<Extract<MessagePart, { type: "parameter" }>["format"]>,
  location: string,
): NonNullable<Extract<MessagePart, { type: "parameter" }>["format"]> {
  if (
    typeof format !== "object" || format === null ||
    (format.type !== "number" && format.type !== "date" &&
      format.type !== "time")
  ) {
    throw new Error(
      `localization parameter ${location} format ${
        JSON.stringify(format)
      } is invalid`,
    );
  }
  if (
    format.options !== undefined &&
    (typeof format.options !== "object" || format.options === null ||
      Array.isArray(format.options))
  ) {
    throw new Error(
      `localization parameter ${location} options must be an object`,
    );
  }
  return Object.freeze({
    type: format.type,
    ...(format.options === undefined
      ? {}
      : { options: Object.freeze({ ...format.options }) }),
  });
}
