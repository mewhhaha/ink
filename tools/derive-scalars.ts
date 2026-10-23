import type { DeriveSchema, DeriveShape } from "@mewhhaha/blot/derive";

// Fixed primitive variants have known offsets. Preserve the checked upstream
// patterns and constructors; specialize only Ink's three primitive codecs.
export function codecScalars(
  shape: DeriveShape,
  schema: DeriveSchema,
  generated: string,
): string {
  for (const constructor of shape.constructors) {
    if (
      !constructor.fields.every((f) => ["U32", "F32", "Bool"].includes(f.type))
    ) continue;
    const variant = schema.variants[constructor.name];
    const fields = constructor.fields.map((field, index) => ({
      ...field,
      index,
      id: variant.fields[field.name],
    })).sort((a, b) => a.id - b.id);
    const pattern = generated.indexOf(`  #${constructor.name} `);
    const start = generated.indexOf(" => do:\n", pattern) + " => do:\n".length;
    const end = generated.indexOf("    break out", start) +
      "    break out".length;
    if (pattern < 0 || start < pattern || end < start) {
      throw new Error("Upstream primitive encoder template changed");
    }
    const words: (number | string)[] = [
      schema.version,
      variant.tag,
      fields.length,
    ];
    for (const field of fields) {
      const v = `v${field.index}`;
      const word = field.type === "U32"
        ? v
        : field.type === "F32"
        ? `_derive_codec.float_word ${v}`
        : `if ${v} then 1 else 0`;
      words.push(field.id, 1, word);
    }
    generated = generated.slice(0, start) + `    break #[${words.join(", ")}]` +
      generated.slice(end);
    const tag = generated.indexOf(`    if tag == ${variant.tag}:\n`);
    const decodeStart = generated.indexOf("\n", tag) + 1;
    const decodeEnd = generated.indexOf("      return #Some", decodeStart);
    if (tag < 0 || decodeEnd < decodeStart) {
      throw new Error("Upstream primitive decoder template changed");
    }
    const checks = [
      `      if count != ${fields.length} || words.length != ${
        3 + 3 * fields.length
      }:`,
      "        return #Nothing",
    ];
    fields.forEach((field, position) => {
      const at = 3 + 3 * position;
      checks.push(
        `      if words[${at}] != ${field.id} || words[${at + 1}] != 1:`,
        "        return #Nothing",
      );
      if (field.type === "F32") {
        checks.push(
          `      let #Some value${field.index} = _derive_codec.float_from_word words[${
            at + 2
          }] else:`,
          "        return #Nothing",
        );
      } else {
        if (field.type === "Bool") {
          checks.push(
            `      if words[${at + 2}] > 1:`,
            "        return #Nothing",
          );
        }
        checks.push(
          `      let value${field.index} = words[${at + 2}]${
            field.type === "Bool" ? " == 1" : ""
          }`,
        );
      }
    });
    generated = generated.slice(0, decodeStart) + checks.join("\n") + "\n" +
      generated.slice(decodeEnd);
  }
  return generated;
}
