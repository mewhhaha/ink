import type { DeriveSchema, DeriveShape } from "@mewhhaha/blot/derive";

// A narrow buffer-allocation pass over the pinned upstream generator's output.
// The upstream parser, schema checks, field codecs and constructors stay in
// charge. Fail on a changed template instead of silently rewriting new syntax.
function replace(source: string, before: string, after: string): string {
  const at = source.indexOf(before);
  if (at < 0 || source.indexOf(before, at + before.length) >= 0) {
    throw new Error("Upstream codec template changed; review the buffer pass");
  }
  return source.slice(0, at) + after + source.slice(at + before.length);
}

export function codecBuffers(
  shape: DeriveShape,
  schema: DeriveSchema,
  generated: string,
): string {
  generated = replace(
    generated,
    "    let rest = @array.slice words 3 (words.length - 3)\n",
    "",
  );
  for (const constructor of shape.constructors) {
    const variant = schema.variants[constructor.name];
    const fields = constructor.fields.map((field, index) => ({
      index,
      id: variant.fields[field.name],
    })).sort((a, b) => a.id - b.id);
    const header =
      `    let out = #[${schema.version}, ${variant.tag}, ${fields.length}]\n`;
    const start = generated.indexOf(header);
    const end = generated.indexOf("    break out", start);
    if (start < 0 || end < start) {
      throw new Error("Upstream codec encoder changed; review the buffer pass");
    }
    const original = generated.slice(start, end);
    let encoded = replace(original, header, "");
    for (const field of fields) {
      encoded = replace(
        encoded,
        `    out := @array.concat self (_derive_codec.frame ${field.id} payload${field.index})\n`,
        "",
      );
    }
    const size = [
      3 + 2 * fields.length,
      ...fields.map((f) => `payload${f.index}.length`),
    ].join(" + ");
    const writes = [
      `    let out = @array.fill (${size}) 0`,
      `    out[0] := ${schema.version}`,
      `    out[1] := ${variant.tag}`,
      `    out[2] := ${fields.length}`,
    ];
    if (fields.length) writes.push("    let cursor = 3");
    fields.forEach((field, position) => {
      writes.push(
        `    out[cursor] := ${field.id}`,
        `    out[cursor + 1] := payload${field.index}.length`,
        `    for index in 0 .. payload${field.index}.length:`,
        `      out[cursor + 2 + index] := payload${field.index}[index]`,
      );
      if (position + 1 < fields.length) {
        writes.push(`    cursor := self + 2 + payload${field.index}.length`);
      }
    });
    generated = replace(
      generated,
      original,
      encoded + writes.join("\n") + "\n",
    );

    const tag = `    if tag == ${variant.tag}:\n`;
    const decodeStart = generated.indexOf(tag);
    const decodeEnd = generated.indexOf("      return #Some", decodeStart);
    if (decodeStart < 0 || decodeEnd < decodeStart) {
      throw new Error("Upstream codec decoder changed; review the buffer pass");
    }
    const originalDecode = generated.slice(decodeStart, decodeEnd);
    let decoded = replace(
      originalDecode,
      "      let tail0 = rest",
      "      let cursor = 3",
    );
    fields.forEach((field, position) => {
      decoded = replace(
        decoded,
        `      let #Some (payload${position}, tail${
          position + 1
        }) = _derive_codec.take_field ${field.id} tail${position} else:\n        return #Nothing`,
        [
          "      if words.length - cursor < 2:",
          "        return #Nothing",
          `      if words[cursor] != ${field.id}:`,
          "        return #Nothing",
          `      let width = words[cursor + 1]`,
          "      cursor := self + 2",
          "      if width > words.length - cursor:",
          "        return #Nothing",
          `      let payload${position} = @array.slice words cursor width`,
          "      cursor := self + width",
        ].join("\n"),
      );
    });
    decoded = replace(
      decoded,
      `tail${fields.length}.length != 0`,
      "cursor != words.length",
    );
    generated = replace(generated, originalDecode, decoded);
  }
  return generated;
}
