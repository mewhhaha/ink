/** Ink metadata around Blot's checked, opt-in source generator. Not a runtime. */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeriveSchema, DeriveShape } from "@mewhhaha/blot/derive";
import { libraryUrl } from "../mod.ts";
import { blotRoot } from "./setup.ts";
import { derivation } from "./derive-runtime.ts";
import { codecBuffers } from "./derive-buffers.ts";
import { codecScalars } from "./derive-scalars.ts";

export interface Schema {
  types: Record<string, DeriveSchema & { key: number; capacity?: number }>;
}
export interface Published {
  types: Record<string, { version: number; key: number; layout: string }>;
}

const text = (value: string) =>
  `#[${Array.from(value, (c) => c.codePointAt(0)).join(", ")}]`;
const integer = (value: number, name: string) => {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffff) {
    throw new Error(`${name} must be an exact nonnegative Ink schema integer`);
  }
};

function describe(shape: DeriveShape, schema: Schema["types"][string]) {
  integer(schema.version, `${shape.name}.version`);
  integer(schema.key, `${shape.name}.key`);
  if (!schema.key) throw new Error("Section key zero is reserved");
  integer(schema.capacity ?? 0, `${shape.name}.capacity`);
  if ((schema.capacity ?? 0) > 8388606) {
    throw new Error("Codec capacity is too large");
  }
  const variants = shape.constructors.map((variant) => {
    const plan = schema.variants[variant.name];
    if (!plan) throw new Error(`Missing variant ${shape.name}.${variant.name}`);
    integer(plan.tag, `${variant.name}.tag`);
    const fields = variant.fields.map((field) => {
      const id = plan.fields[field.name];
      integer(id, `${variant.name}.${field.name}.id`);
      return { id, name: field.name, type: field.type };
    }).sort((a, b) => a.id - b.id);
    if (new Set(fields.map((f) => f.id)).size !== fields.length) {
      throw new Error(`Duplicate field id in ${variant.name}`);
    }
    if (Object.keys(plan.fields).length !== fields.length) {
      throw new Error(`Unknown field in ${variant.name}`);
    }
    return { tag: plan.tag, name: variant.name, fields };
  }).sort((a, b) => a.tag - b.tag);
  if (new Set(variants.map((v) => v.tag)).size !== variants.length) {
    throw new Error(`Duplicate variant tag in ${shape.name}`);
  }
  if (Object.keys(schema.variants).length !== variants.length) {
    throw new Error(`Unknown variant in ${shape.name}`);
  }
  return variants;
}

export async function checked(source: string, imports: Record<string, URL>) {
  const args = [
    "check-project",
    source,
    "--std-root",
    fileURLToPath(new URL("std/", blotRoot)),
    "--prelude",
    fileURLToPath(new URL("std/prelude.blot", blotRoot)),
  ];
  for (
    const [prefix, directory] of Object.entries({
      "ink/": libraryUrl,
      ...imports,
    })
  ) {
    args.push("--alias", `${prefix}=${fileURLToPath(directory)}`);
  }
  const result = await new Deno.Command(
    new URL("zig-native/zig-out/bin/blotc", blotRoot),
    { args, stdout: "piped", stderr: "piped" },
  ).output();
  if (!result.success) {
    const diagnostics = new TextDecoder().decode(result.stdout).trim().split(
      "\n",
    ).flatMap((line) => {
      try {
        const record = JSON.parse(line);
        return record.kind === "diagnostic" ? [record] : [];
      } catch {
        return [];
      }
    });
    throw new Error(
      JSON.stringify(diagnostics) + new TextDecoder().decode(result.stderr),
    );
  }
}

export async function generate(options: {
  source: string;
  schema: string;
  output: string;
  published?: string;
  check?: boolean;
  imports?: Record<string, URL>;
}): Promise<Published> {
  const source = resolve(options.source), output = resolve(options.output);
  if (source === output || dirname(source) !== dirname(output)) {
    throw new Error(
      "Generated output must be beside, and distinct from, its source",
    );
  }
  const imports = options.imports ?? {};
  await checked(source, imports);
  const { dataShapes, deriveCodec } = await derivation();
  const code = await Deno.readTextFile(source);
  const shapes = new Map(
    (await dataShapes(code)).map((shape) => [shape.name, shape]),
  );
  const manifest = JSON.parse(
    await Deno.readTextFile(options.schema),
  ) as Schema;
  const previous: Published = options.published
    ? JSON.parse(await Deno.readTextFile(options.published))
    : { types: {} };
  const published: Published = { types: {} };
  const generated: string[] = [];
  const keys = new Set<number>();
  const names = Object.keys(manifest.types).sort();
  const ordered: string[] = [], visiting = new Set<string>();
  const visit = (name: string) => {
    if (ordered.includes(name)) return;
    if (visiting.has(name)) {
      throw new Error(`${name}: recursive fields require handwritten codecs`);
    }
    visiting.add(name);
    for (
      const field of shapes.get(name)?.constructors.flatMap((v) => v.fields) ??
        []
    ) {
      for (const dependency of names) {
        if (new RegExp(`\\b${dependency}\\b`).test(field.type)) {
          visit(dependency);
        }
      }
    }
    visiting.delete(name);
    ordered.push(name);
  };
  for (const name of names) visit(name);
  for (const name of ordered) {
    const plan = manifest.types[name], shape = shapes.get(name);
    if (!shape) throw new Error(`No checked data declaration for ${name}`);
    const variants = describe(shape, plan);
    if (keys.has(plan.key)) {
      throw new Error(`Duplicate section key ${plan.key}`);
    }
    keys.add(plan.key);
    // Names are inspection labels; persisted identity is ids plus checked types.
    const layout = JSON.stringify({
      capacity: plan.capacity ?? 0,
      variants: variants.map((v) => ({
        tag: v.tag,
        fields: v.fields.map((f) => ({ id: f.id, type: f.type })),
      })),
    });
    const old = previous.types[name];
    if (old && plan.version < old.version) {
      throw new Error(`${name}: codec version decreased`);
    }
    if (old && old.key !== plan.key) {
      throw new Error(`${name}: published section key changed`);
    }
    if (old && old.version === plan.version && old.layout !== layout) {
      throw new Error(`${name}: layout changed without a codec version change`);
    }
    published.types[name] = { version: plan.version, key: plan.key, layout };
    generated.push(
      codecScalars(
        shape,
        plan,
        codecBuffers(shape, plan, deriveCodec(shape, plan)),
      ),
    );
    const descriptor = variants.map((v) =>
      `#_ink_codec.Variant { tag: ${v.tag}, label: ${text(v.name)}, fields: #[${
        v.fields.map((f) =>
          `#_ink_codec.Field { id: ${f.id}, label: ${
            text(f.name)
          }, type_name: ${text(f.type)}, kind: #_ink_codec.${
            ({ U32: "Unsigned", F32: "Float", Bool: "Boolean" } as Record<
              string,
              string
            >)[f.type] ?? "Encoded"
          } }`
        ).join(", ")
      }] }`
    ).join(", ");
    generated.push(
      `const ${name}_codec = fn migration => _ink_codec.bridge ${plan.key} ${plan.version} ${
        plan.capacity ?? 0
      } (fn (value: ${name}) => _ink_codec.encode value) (fn (words: Array U32) -> Maybe ${name} => _ink_codec.Codec.decode words) migration\n`,
    );
    generated.push(
      `const ${name}_words = fn migration => _ink_codec.saved ${plan.key} ${plan.version} (fn (value: ${name}) => _ink_codec.encode value) (fn (words: Array U32) -> Maybe ${name} => _ink_codec.Codec.decode words) migration\n`,
    );
    generated.push(
      `const ${name}_descriptor = #_ink_codec.Descriptor { version: ${plan.version}, variants: #[${descriptor}] }\n`,
    );
  }
  const contents = "// Generated by Ink using upstream checked derivation.\n" +
    'import * as _derive_codec from "ink/codec"\nimport * as _ink_codec from "ink/codec"\n' +
    code + "\n" + generated.join("\n");
  const temporary = await Deno.makeTempFile({
    dir: dirname(output),
    prefix: ".derive-",
    suffix: ".blot",
  });
  try {
    await Deno.writeTextFile(temporary, contents);
    await checked(temporary, imports);
    if (options.check) {
      if (await Deno.readTextFile(output) !== contents) {
        throw new Error(`Stale generated output: ${output}`);
      }
    } else await Deno.rename(temporary, output);
  } finally {
    await Deno.remove(temporary).catch(() => {});
  }
  return published;
}

if (import.meta.main) {
  const arg = (name: string) => {
    const at = Deno.args.indexOf(name);
    if (at < 0 || !Deno.args[at + 1]) throw new Error(`Missing ${name}`);
    return Deno.args[at + 1];
  };
  const result = await generate({
    source: arg("--source"),
    schema: arg("--schema"),
    output: arg("--output"),
    published: Deno.args.includes("--published")
      ? arg("--published")
      : undefined,
    check: Deno.args.includes("--check"),
  });
  if (Deno.args.includes("--manifest-output")) {
    await Deno.writeTextFile(
      arg("--manifest-output"),
      JSON.stringify(result, null, 2) + "\n",
    );
  }
}
