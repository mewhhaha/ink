/** Host-side views of the same records and variants generated for Blot. */
import type { NamedNode, Node, Schema } from "./schema.ts";

function typeOf(node: Node): string {
  switch (node.kind) {
    case "bool":
      return "boolean";
    case "vec2":
      return "[number, number]";
    case "vec3":
      return "[number, number, number]";
    case "vec4":
    case "quat":
    case "color":
      return "[number, number, number, number]";
    case "enum":
    case "struct":
      return node.typeName;
    case "list":
      return `${typeOf(node.element)}[]`;
    default:
      return "number";
  }
}

const record = (fields: NamedNode[]) =>
  fields.length
    ? `{\n${fields.map((f) => `  ${f.name}: ${typeOf(f.node)};`).join("\n")}\n}`
    : "Record<string, never>";

export function generateTypeScript(schema: Schema): string {
  const out = [
    "// Generated from schema.ts by Ink. Regenerate with `ink gen`; do not edit.",
    'import type { EntityModel as InkEntity, InputModel as InkInput, WorldModel as InkWorld } from "@ink/schema";',
    "",
  ];
  for (const node of schema.types) {
    out.push(
      `export type ${node.typeName} = ${
        node.kind === "enum"
          ? node.values.map((x) => JSON.stringify(x)).join(" | ")
          : record(node.fields)
      };`,
      "",
    );
  }
  for (const r of [...schema.components, ...schema.resources]) {
    out.push(`export type ${r.typeName} = ${record(r.fields)};`, "");
  }
  for (
    const [name, records] of [["Components", schema.components], [
      "Resources",
      schema.resources,
    ]] as const
  ) {
    if (!records.length) {
      out.push(`export type ${name} = Record<never, never>;`, "");
      continue;
    }
    out.push(
      `export type ${name} = {`,
      ...records.map((r) => `  ${r.name}: ${r.typeName};`),
      "};",
      "",
    );
  }
  out.push(
    'export type Entity = Omit<InkEntity, "components"> & { components: Partial<Components> };',
    'export type World = Omit<InkWorld, "entities" | "resources"> & { entities: Entity[]; resources: Resources };',
    "",
    schema.actions.length
      ? "export type Actions = {"
      : "export type Actions = Record<never, never>",
    ...schema.actions.map(({ name, action }) =>
      `  ${name}: ${
        action.kind === "button"
          ? "{ down: boolean; pressed: boolean; released: boolean }"
          : action.kind === "axis2"
          ? "[number, number]"
          : "number"
      };`
    ),
    schema.actions.length ? "};" : ";",
    'export type Input = Omit<InkInput, "actions"> & { actions: Actions };',
    "",
    `export type Event = ${
      schema.events.length
        ? schema.events.map((e) =>
          `{ name: ${JSON.stringify(e.name)}; value: ${record(e.fields)} }`
        ).join(" | ")
        : "never"
    };`,
    "",
    "export const messages = {",
    ...schema.messages.map((m) => `  ${m.name}: ${m.id},`),
    "} as const;",
    "export type Message = keyof typeof messages;",
    `export const names = ${
      JSON.stringify(
        Object.fromEntries(schema.names.map((n) => [n.name, n.id])),
      )
    } as const;`,
    `export const schemaHash = ${schema.hash};`,
    "",
  );
  return out.join("\n");
}
