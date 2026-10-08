/**
 * A schema is the one description of a game's data that the host and the
 * Blot guest share. Components, resources and events are records of fields;
 * actions name the inputs a game reads. From it Ink derives the packed state
 * layout, the Blot types and codecs, scene files and generic inspectors.
 */
import type { Action, Field } from "./fields.ts";
import { textId, validateTextIds } from "./text.ts";

export interface RecordMeta {
  description?: string;
  /** A short icon name shown by editors. */
  icon?: string;
  /** Editor grouping, e.g. "Rendering" or "Gameplay". */
  category?: string;
  /** Hide from generic "add component" menus. */
  hidden?: boolean;
}

export interface RecordDef extends RecordMeta {
  fields: Record<string, Field>;
}

/** A component or resource with editor metadata. */
export const component = (
  fields: Record<string, Field>,
  meta: RecordMeta = {},
): RecordDef => ({ ...meta, fields });

export type RecordInput = RecordDef | Record<string, Field>;

export interface SchemaInput {
  /** Per-entity data. An entity has any subset of components. */
  components?: Record<string, RecordInput>;
  /** Singletons that exist once per world. */
  resources?: Record<string, RecordInput>;
  /** Values the game emits during a step for the host: sounds, logs, ... */
  events?: Record<string, RecordInput>;
  /** Named inputs and their default bindings. */
  actions?: Record<string, Action>;
  /** Texts Blot refers to by id, with `{0}` and `{1}` argument slots. */
  messages?: Record<string, string>;
  /** Language of `messages`. Missing translations fall back to these texts. */
  defaultLocale?: string;
  /** Locale -> message key -> translation, with the same argument slots. */
  locales?: Record<string, Record<string, string>>;
  /** Symbolic aliases for names the game needs, e.g. { player: "Player" }. */
  names?: Record<string, string>;
}

/** A field after normalization, with its packed size and Blot type name. */
export type Node =
  | {
    kind:
      | "f32"
      | "u32"
      | "bool"
      | "vec2"
      | "vec3"
      | "vec4"
      | "quat"
      | "color"
      | "entity"
      | "asset"
      | "message";
    field: Field;
    lanes: number;
  }
  | {
    kind: "enum";
    field: Field & { kind: "enum" };
    lanes: 1;
    typeName: string;
    values: readonly string[];
  }
  | {
    kind: "struct";
    field: Field & { kind: "struct" };
    /** null when a nested list makes the size depend on the value. */
    lanes: number | null;
    typeName: string;
    fields: NamedNode[];
  }
  | {
    kind: "list";
    field: Field & { kind: "list" };
    lanes: null;
    element: Node & { lanes: number };
  };

export interface NamedNode {
  name: string;
  node: Node;
}

export interface RecordSchema extends RecordMeta {
  /** Key in the schema, snake_case. */
  name: string;
  /** Blot type and constructor name. */
  typeName: string;
  fields: NamedNode[];
  lanes: number | null;
  /** Position within its group; components are encoded in this order. */
  index: number;
}

export interface ActionSchema {
  name: string;
  action: Action;
  /** Lanes in the input packet: 3 for buttons, 1 for axes, 2 for axis2. */
  lanes: number;
}

export interface Schema {
  /** 24-bit layout identity stored in every state packet. */
  hash: number;
  components: RecordSchema[];
  resources: RecordSchema[];
  events: RecordSchema[];
  actions: ActionSchema[];
  messages: { name: string; text: string; id: number }[];
  defaultLocale: string;
  locales: Record<string, Record<string, string>>;
  names: { name: string; text: string; id: number }[];
  /** Asset kinds referenced by asset fields, sorted. */
  assetKinds: string[];
  /** Every enum and struct type declared, in declaration order. */
  types: (Node & { kind: "enum" | "struct" })[];
  component(name: string): RecordSchema | undefined;
  resource(name: string): RecordSchema | undefined;
  event(name: string): RecordSchema | undefined;
}

export class SchemaError extends Error {
  override name = "SchemaError";
}

const keywords = new Set([
  "as",
  "break",
  "case",
  "complete",
  "const",
  "contract",
  "data",
  "do",
  "effect",
  "else",
  "entry",
  "ever",
  "fn",
  "for",
  "from",
  "if",
  "import",
  "in",
  "infix",
  "infixl",
  "infixr",
  "is",
  "let",
  "monad",
  "of",
  "return",
  "self",
  "then",
  "type",
  "use",
  "where",
  "yield",
]);

/** Type names the generated module or the Ink Blot library already use. */
const reservedTypes = new Set([
  "Actions",
  "Array",
  "Bool",
  "Button",
  "Color",
  "Components",
  "Emit",
  "Entity",
  "Event",
  "F32",
  "Input",
  "Iteration",
  "List",
  "Maybe",
  "Message",
  "Pointer",
  "PlayerInput",
  "Quat",
  "Random",
  "Ray",
  "Resources",
  "Result",
  "Type",
  "U32",
  "Unit",
  "Vec2",
  "Vec3",
  "Vec4",
  "World",
]);

const reservedConstructors = new Set([
  "True",
  "False",
  "Some",
  "Nothing",
  "Ok",
  "Err",
  "Continue",
  "Done",
  "Type",
  // Constructors of the types the generated module imports from Ink's library.
  "Vec2",
  "Vec3",
  "Vec4",
  "Quat",
  "Color",
  "Ray",
  "Button",
  "Pointer",
]);

const identifier = /^[a-z][a-z0-9_]*$/;

/** Generated constants are named `<kind>_<asset>`, `default_<component>`,
 * `message_<name>`, `decode_<type>`...; these names would collide. */
const reservedKinds = new Set([
  "decode",
  "default",
  "encode",
  "list",
  "message",
  "name",
  "random",
  "size",
]);
const reservedComponents = new Set(["resources", "name_id"]);

export function pascal(name: string): string {
  return name.split(/[_\-\s]+/).filter(Boolean).map((part) =>
    part[0].toUpperCase() + part.slice(1)
  ).join("");
}

function singular(name: string): string {
  if (name.endsWith("ies")) return name.slice(0, -3) + "y";
  if (name.endsWith("s") && !name.endsWith("ss")) return name.slice(0, -1);
  return name;
}

function isRecordDef(value: RecordInput): value is RecordDef {
  // A bare field record may have a field called `fields`; that value is a
  // Field, whose `kind` is a string.
  const fields = (value as RecordDef).fields as unknown;
  return typeof fields === "object" && fields !== null &&
    typeof (fields as { kind?: unknown }).kind !== "string";
}

function checkName(name: string, where: string) {
  if (!identifier.test(name) || keywords.has(name)) {
    throw new SchemaError(
      `${where}: "${name}" must be a snake_case identifier and not a Blot keyword`,
    );
  }
}

const scalarLanes: Record<string, number> = {
  f32: 1,
  u32: 1,
  bool: 1,
  entity: 1,
  asset: 1,
  message: 1,
  vec2: 2,
  vec3: 3,
  vec4: 4,
  quat: 4,
  color: 4,
};

export function defineSchema(input: SchemaInput): Schema {
  const types: (Node & { kind: "enum" | "struct" })[] = [];
  const typeNames = new Map<string, string>();
  const constructors = new Map<string, string>();
  const assetKinds = new Set<string>();

  const claimType = (typeName: string, owner: string) => {
    if (!/^[A-Z][A-Za-z0-9]*$/.test(typeName)) {
      throw new SchemaError(`${owner}: invalid Blot type name "${typeName}"`);
    }
    if (reservedTypes.has(typeName)) {
      throw new SchemaError(
        `${owner}: type name "${typeName}" is reserved by Ink; rename it or pass { name }`,
      );
    }
    const previous = typeNames.get(typeName);
    if (previous) {
      throw new SchemaError(
        `${owner}: type name "${typeName}" is already used by ${previous}; pass { name } to rename one`,
      );
    }
    typeNames.set(typeName, owner);
  };
  const claimConstructor = (name: string, owner: string) => {
    if (reservedConstructors.has(name)) {
      throw new SchemaError(`${owner}: constructor #${name} is reserved`);
    }
    const previous = constructors.get(name);
    if (previous) {
      throw new SchemaError(
        `${owner}: constructor #${name} is already used by ${previous}; Blot constructors share one namespace per module`,
      );
    }
    constructors.set(name, owner);
  };

  const normalize = (field: Field, owner: string, fieldName: string): Node => {
    const where = `${owner}.${fieldName}`;
    switch (field.kind) {
      case "enum": {
        if (field.values.length === 0) {
          throw new SchemaError(`${where}: an enum needs at least one value`);
        }
        if (!field.values.includes(field.default)) {
          throw new SchemaError(
            `${where}: default "${field.default}" is not one of its values`,
          );
        }
        const typeName = field.name ?? pascal(owner) + pascal(fieldName);
        claimType(typeName, where);
        for (const value of field.values) {
          checkName(value, `${where} value`);
          claimConstructor(pascal(value), where);
        }
        const node = {
          kind: "enum" as const,
          field,
          lanes: 1 as const,
          typeName,
          values: field.values,
        };
        types.push(node);
        return node;
      }
      case "struct": {
        const typeName = field.name ?? pascal(owner) + pascal(fieldName);
        claimType(typeName, where);
        claimConstructor(typeName, where);
        const fields = Object.entries(field.fields).map(([name, child]) => {
          checkName(name, `${typeName} field`);
          return { name, node: normalize(child, typeName, name) };
        });
        const lanes = fields.reduce<number | null>(
          (total, { node }) =>
            total === null || node.lanes === null ? null : total + node.lanes,
          0,
        );
        const node = {
          kind: "struct" as const,
          field,
          lanes,
          typeName,
          fields,
        };
        types.push(node);
        return node;
      }
      case "list": {
        const element = normalize(
          field.of.kind === "struct" && !field.of.name
            ? { ...field.of, name: pascal(owner) + pascal(singular(fieldName)) }
            : field.of,
          owner,
          singular(fieldName),
        );
        if (element.lanes === null) {
          throw new SchemaError(
            `${where}: list elements must have a fixed size (no nested lists)`,
          );
        }
        return {
          kind: "list",
          field,
          lanes: null,
          element: element as Node & { lanes: number },
        };
      }
      case "asset":
        checkName(field.asset, `${where} asset kind`);
        if (reservedKinds.has(field.asset)) {
          throw new SchemaError(
            `${where}: asset kind "${field.asset}" is reserved`,
          );
        }
        assetKinds.add(field.asset);
        return { kind: field.kind, field, lanes: 1 };
      default:
        return { kind: field.kind, field, lanes: scalarLanes[field.kind] };
    }
  };

  const records = (
    group: Record<string, RecordInput> | undefined,
    label: string,
  ): RecordSchema[] =>
    Object.entries(group ?? {}).map(([name, value], index) => {
      checkName(name, label);
      const def = isRecordDef(value) ? value : { fields: value };
      const { fields: _, ...meta } = def;
      const typeName = pascal(name);
      claimType(typeName, `${label} "${name}"`);
      claimConstructor(typeName, `${label} "${name}"`);
      const fields = Object.entries(def.fields).map(([fieldName, field]) => {
        checkName(fieldName, `${label} "${name}" field`);
        return { name: fieldName, node: normalize(field, typeName, fieldName) };
      });
      const lanes = fields.reduce<number | null>(
        (total, { node }) =>
          total === null || node.lanes === null ? null : total + node.lanes,
        0,
      );
      return { ...meta, name, typeName, fields, lanes, index };
    });

  const components = records(input.components, "component");
  for (const c of components) {
    if (reservedComponents.has(c.name)) {
      throw new SchemaError(`component "${c.name}" is reserved`);
    }
  }
  const resources = records(input.resources, "resource");
  // Events are variants of one Blot type: their constructors are the event
  // names, so they need no separate type.
  const events = Object.entries(input.events ?? {}).map(
    ([name, value], index) => {
      checkName(name, "event");
      const def = isRecordDef(value) ? value : { fields: value };
      const { fields: _, ...meta } = def;
      const typeName = pascal(name);
      claimConstructor(typeName, `event "${name}"`);
      const fields = Object.entries(def.fields).map(([fieldName, field]) => {
        checkName(fieldName, `event "${name}" field`);
        return {
          name: fieldName,
          node: normalize(field, typeName + "Event", fieldName),
        };
      });
      const lanes = fields.reduce<number | null>(
        (total, { node }) =>
          total === null || node.lanes === null ? null : total + node.lanes,
        0,
      );
      return { ...meta, name, typeName, fields, lanes, index };
    },
  );

  const actions = Object.entries(input.actions ?? {}).map(([name, action]) => {
    checkName(name, "action");
    const lanes = action.kind === "button" ? 3 : action.kind === "axis" ? 1 : 2;
    return { name, action, lanes };
  });

  const messages = Object.entries(input.messages ?? {}).map((
    [name, text],
    index,
  ) => {
    checkName(name, "message");
    return { name, text, id: index + 1 };
  });

  const hash = layoutHash({ components, resources, events, actions });
  const defaultLocale = input.defaultLocale ?? "en";
  const locales = structuredClone(input.locales ?? {});
  for (const [locale, translations] of Object.entries(locales)) {
    for (const [name, text] of Object.entries(translations)) {
      if (!messages.some((m) => m.name === name) || typeof text !== "string") {
        throw new SchemaError(
          `locale ${locale}: unknown or invalid message "${name}"`,
        );
      }
    }
  }
  const names = Object.entries(input.names ?? {}).map(([name, text]) => {
    checkName(name, "name symbol");
    if (typeof text !== "string" || !text) {
      throw new SchemaError(`name ${name}: expected nonempty text`);
    }
    return { name, text, id: textId(text) };
  });
  validateTextIds(names.map((n) => n.text));
  const byName = (list: RecordSchema[]) => {
    const map = new Map(list.map((record) => [record.name, record]));
    return (name: string) => map.get(name);
  };
  return {
    hash,
    components,
    resources,
    events,
    actions,
    messages,
    defaultLocale,
    locales,
    names,
    assetKinds: [...assetKinds].sort(),
    types,
    component: byName(components),
    resource: byName(resources),
    event: byName(events),
  };
}

function shape(node: Node): unknown {
  switch (node.kind) {
    case "enum":
      return ["enum", node.values];
    case "struct":
      return ["struct", node.fields.map((f) => [f.name, shape(f.node)])];
    case "list":
      return ["list", shape(node.element)];
    default:
      return node.kind;
  }
}

/** FNV-1a over the layout-relevant structure, folded to 24 bits so the hash
 * survives a round trip through an F32 lane. */
function layoutHash(
  parts: {
    components: RecordSchema[];
    resources: RecordSchema[];
    events: RecordSchema[];
    actions: ActionSchema[];
  },
): number {
  const canonical = JSON.stringify([
    3, // Entity name symbols and the variable per-player input tail.
    parts.components.map((
      r,
    ) => [r.name, r.fields.map((f) => [f.name, shape(f.node)])]),
    parts.resources.map((
      r,
    ) => [r.name, r.fields.map((f) => [f.name, shape(f.node)])]),
    parts.events.map((
      r,
    ) => [r.name, r.fields.map((f) => [f.name, shape(f.node)])]),
    parts.actions.map((a) => [a.name, a.action.kind]),
  ]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return ((hash >>> 24) ^ hash) & 0xffffff;
}
