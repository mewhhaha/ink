/**
 * Generates a project's Blot module from its schema: the component, resource,
 * input and event types, their packet codecs, defaults, asset and message
 * ids, world helpers and the step runner. The output is ordinary Blot that a
 * game imports, e.g. `import * as s from "./schema.gen"`.
 *
 * The module imports Ink's Blot library under the `ink/` alias.
 */
import { INPUT_HEADER, STATE_HEADER } from "./codec.ts";
import type { Node, RecordSchema, Schema } from "./schema.ts";
import type { Catalog } from "./scene.ts";
import { physicsImports, physicsSection } from "./physics.ts";

const snake = (typeName: string) =>
  typeName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

export function f32Literal(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`not finite: ${value}`);
  const v = Math.fround(value);
  // The shortest decimal that rounds to the same F32.
  let shortest = v;
  for (let digits = 1; digits <= 9; digits++) {
    const candidate = Number(v.toPrecision(digits));
    if (Math.fround(candidate) === v) {
      shortest = candidate;
      break;
    }
  }
  let text = Math.abs(shortest) >= 1e15
    ? shortest.toExponential().replace("e+", "e")
    : Number.isInteger(shortest)
    ? shortest.toFixed(1)
    : String(shortest).replace("e+", "e");
  if (!/[.e]/.test(text)) text += ".0";
  return v < 0 || Object.is(v, -0)
    ? `(${text.startsWith("-") ? "" : "-"}${text})`
    : text;
}

function blotType(node: Node): string {
  switch (node.kind) {
    case "f32":
      return "F32";
    case "u32":
    case "entity":
    case "asset":
    case "message":
      return "U32";
    case "bool":
      return "Bool";
    case "vec2":
      return "Vec2";
    case "vec3":
      return "Vec3";
    case "vec4":
      return "Vec4";
    case "quat":
      return "Quat";
    case "color":
      return "Color";
    case "enum":
    case "struct":
      return node.typeName;
    case "list": {
      const inner = blotType(node.element);
      return `Array ${inner.includes(" ") ? `(${inner})` : inner}`;
    }
  }
}

function defaultExpr(node: Node): string {
  const field = node.field as { default?: unknown };
  const vector = (keys: string, type: string) => {
    const values = field.default as number[];
    return `#${type} { ${
      keys.split("").map((k, i) => `${k}: ${f32Literal(values[i])}`).join(", ")
    } }`;
  };
  switch (node.kind) {
    case "f32":
      return f32Literal(field.default as number);
    case "u32":
      return String(field.default);
    case "bool":
      return field.default ? "#True" : "#False";
    case "entity":
    case "asset":
    case "message":
      return "0";
    case "vec2":
      return vector("xy", "Vec2");
    case "vec3":
      return vector("xyz", "Vec3");
    case "vec4":
      return vector("xyzw", "Vec4");
    case "quat":
      return vector("xyzw", "Quat");
    case "color":
      return vector("rgba", "Color");
    case "enum":
      return `#${pascalValue(node.field.default)}`;
    case "struct":
      return recordLiteral(node.typeName, node.fields, defaultExpr);
    case "list":
      return "#[]";
  }
}

const pascalValue = (value: string) =>
  value.split("_").map((p) => p[0].toUpperCase() + p.slice(1)).join("");

function recordLiteral(
  typeName: string,
  fields: { name: string; node: Node }[],
  expr: (node: Node) => string,
): string {
  if (fields.length === 0) return `#${typeName}`;
  return `#${typeName} { ${
    fields.map((f) => `${f.name}: ${expr(f.node)}`).join(", ")
  } }`;
}

/** Offset expression `o + k`. */
const at = (base: string, k: number) => (k === 0 ? base : `${base} + ${k}`);
const paren = (expr: string) => (/^[\w.]+$/.test(expr) ? expr : `(${expr})`);

/** Expression reading a fixed-size node at `offset`. Vectors build their
 * records inline: measurably cheaper than a call per vector. */
function readFixed(node: Node, offset: string): string {
  const o = paren(offset);
  const lane = (k: number) => `v[${at(offset, k)}]`;
  const record = (type: string, keys: string) =>
    `#${type} { ${
      keys.split("").map((key, i) => `${key}: ${lane(i)}`).join(", ")
    } }`;
  switch (node.kind) {
    case "f32":
      return `v[${offset}]`;
    case "u32":
    case "entity":
    case "asset":
    case "message":
      return `packet.u32 v ${o}`;
    case "bool":
      return `packet.bool v ${o}`;
    case "vec2":
      return record("Vec2", "xy");
    case "vec3":
      return record("Vec3", "xyz");
    case "vec4":
      return record("Vec4", "xyzw");
    case "quat":
      return record("Quat", "xyzw");
    case "color":
      return record("Color", "rgba");
    case "enum":
      return `decode_${snake(node.typeName)} (packet.u32 v ${o})`;
    case "struct":
      return `decode_${snake(node.typeName)} v ${o}`;
    case "list":
      throw new Error("lists are not fixed-size");
  }
}

/** Lane expressions for a fixed-size value at `path`. */
function lanesFixed(node: Node, path: string): string[] {
  switch (node.kind) {
    case "f32":
      return [path];
    case "u32":
    case "entity":
    case "asset":
    case "message":
      return [`U32.to_f32 ${paren(path)}`];
    case "bool":
      return [`packet.flag ${paren(path)}`];
    case "vec2":
      return ["x", "y"].map((k) => `${path}.${k}`);
    case "vec3":
      return ["x", "y", "z"].map((k) => `${path}.${k}`);
    case "vec4":
    case "quat":
      return ["x", "y", "z", "w"].map((k) => `${path}.${k}`);
    case "color":
      return ["r", "g", "b", "a"].map((k) => `${path}.${k}`);
    case "enum":
      return [`encode_${snake(node.typeName)} ${paren(path)}`];
    case "struct":
      return node.fields.flatMap((f) =>
        lanesFixed(f.node, `${path}.${f.name}`)
      );
    case "list":
      throw new Error("lists are not fixed-size");
  }
}

/** Chunks (Array F32 expressions) encoding a possibly variable value. */
function chunks(node: Node, path: string): string[] {
  if (node.lanes !== null) return [`#[${lanesFixed(node, path).join(", ")}]`];
  if (node.kind === "list") return [`${listEncoder(node)} ${paren(path)}`];
  if (node.kind === "struct") {
    return node.fields.flatMap((f) => chunks(f.node, `${path}.${f.name}`));
  }
  throw new Error(`no chunks for ${(node as Node).kind}`);
}

function mergeChunks(parts: string[]): string[] {
  // Join adjacent literal chunks into one literal.
  const out: string[] = [];
  for (const part of parts) {
    const last = out[out.length - 1];
    if (last?.startsWith("#[") && part.startsWith("#[")) {
      const inner = [last.slice(2, -1), part.slice(2, -1)].filter(Boolean);
      out[out.length - 1] = `#[${inner.join(", ")}]`;
    } else {
      out.push(part);
    }
  }
  return out;
}

const listEncoders = new Map<string, string>();
function listEncoder(node: Node & { kind: "list" }): string {
  return `encode_list_${elementKey(node.element)}`;
}
function elementKey(node: Node): string {
  return node.kind === "enum" || node.kind === "struct"
    ? snake(node.typeName)
    : node.kind;
}

class Out {
  lines: string[] = [];
  line(text = "") {
    this.lines.push(text);
  }
  block(text: string) {
    this.lines.push(...text.split("\n"));
  }
  toString() {
    return this.lines.join("\n") + "\n";
  }
}

function identifierFor(path: string, used: Set<string>): string {
  let base = path.replace(/^builtin:/, "").replace(
    /\.atlas\.json$|\.[^./]+$/,
    "",
  )
    .replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
  if (!/^[a-z]/.test(base)) base = "a_" + base;
  let name = base;
  for (let i = 2; used.has(name); i++) name = `${base}_${i}`;
  used.add(name);
  return name;
}

/** Names Blot uses for each asset path, per kind. */
export function assetIdentifiers(
  catalog: Catalog,
): Record<string, Record<string, string>> {
  return Object.fromEntries(
    Object.entries(catalog.assets).map(([kind, paths]) => {
      const used = new Set<string>();
      return [
        kind,
        Object.fromEntries(paths.map((p) => [p, identifierFor(p, used)])),
      ];
    }),
  );
}

/** Lanes a value occupies, as a Blot expression (a constant when fixed). */
function laneCount(node: Node, path: string): string {
  if (node.lanes !== null) return String(node.lanes);
  if (node.kind === "list") {
    return `(1 + ${path}.length * ${node.element.lanes})`;
  }
  return `(lanes_${snake((node as { typeName: string }).typeName)} ${
    paren(path)
  })`;
}

function recordLaneCount(
  fields: { name: string; node: Node }[],
  path: string,
): string {
  const parts = fields.map((f) => laneCount(f.node, `${path}.${f.name}`));
  const constant = parts.filter((p) => /^\d+$/.test(p)).reduce(
    (n, p) => n + Number(p),
    0,
  );
  const dynamic = parts.filter((p) => !/^\d+$/.test(p));
  return [
    ...(constant || dynamic.length === 0 ? [String(constant)] : []),
    ...dynamic,
  ]
    .join(" + ");
}

/**
 * Statements writing `node` into the `out` array at cursor `q`. Fixed-size
 * values use constant offsets from the cursor; lists and variable structs move
 * the cursor. Writing in place avoids building and flattening chunk arrays.
 */
function emitWrite(
  lines: string[],
  indent: string,
  node: Node,
  path: string,
  state: { k: number; n: number },
) {
  const flush = () => {
    if (state.k > 0) lines.push(`${indent}q := self + ${state.k}`);
    state.k = 0;
  };
  const slot = (k: number) => (k === 0 ? "q" : `q + ${k}`);
  if (node.lanes !== null) {
    lanesFixed(node, path).forEach((lane, i) =>
      lines.push(`${indent}out[${slot(state.k + i)}] := ${lane}`)
    );
    state.k += node.lanes;
    return;
  }
  if (node.kind === "list") {
    flush();
    const id = state.n++;
    const width = node.element.lanes!;
    lines.push(`${indent}out[q] := U32.to_f32 ${path}.length`);
    if (width > 0) {
      lines.push(`${indent}for i_${id} in 0..${path}.length:`);
      lines.push(`${indent}  let item_${id} = ${path}[i_${id}]`);
      lanesFixed(node.element, `item_${id}`).forEach((lane, j) =>
        lines.push(
          `${indent}  out[q + 1 + i_${id} * ${width}${
            j ? ` + ${j}` : ""
          }] := ${lane}`,
        )
      );
    }
    lines.push(`${indent}q := self + (1 + ${path}.length * ${width})`);
    return;
  }
  if (node.kind === "struct") {
    for (const f of node.fields) {
      emitWrite(lines, indent, f.node, `${path}.${f.name}`, state);
    }
    return;
  }
  throw new Error(`cannot write ${(node as Node).kind}`);
}

export function generateBlot(schema: Schema, catalog: Catalog): string {
  listEncoders.clear();
  const out = new Out();
  const lists: (Node & { kind: "list" })[] = [];
  const collectLists = (node: Node) => {
    if (node.kind === "list") {
      if (
        !lists.some((l) => elementKey(l.element) === elementKey(node.element))
      ) {
        lists.push(node);
      }
    } else if (node.kind === "struct") {
      node.fields.forEach((f) => collectLists(f.node));
    }
  };
  for (
    const record of [
      ...schema.components,
      ...schema.resources,
      ...schema.events,
    ]
  ) {
    record.fields.forEach((f) => collectLists(f.node));
  }

  out.block(
    `// Generated by Ink from the project schema. Do not edit: change the schema.
// Layout ${schema.hash}. See packages/schema/codec.ts for the packet format.
import * as array from "std/array"
import { Vec2, Vec3 } from "std/vector"
import { Color, Quat, Ray, Vec4 } from "ink/math"
import { Button, Pointer } from "ink/input"
import * as packet from "ink/packet"
import * as rng from "ink/random"
${physicsImports(schema)}
const layout_hash: U32 = ${schema.hash}
`,
  );

  // Types ---------------------------------------------------------------------
  out.line("// Types");
  for (const type of schema.types) {
    if (type.kind === "enum") {
      out.line(
        `type ${type.typeName} is data = ${
          type.values.map((v) => `#${pascalValue(v)}`).join(" | ")
        }`,
      );
    } else {
      out.line(
        type.fields.length === 0
          ? `type ${type.typeName} is data = #${type.typeName}`
          : `type ${type.typeName} is data = #${type.typeName} { ${
            type.fields.map((f) => `${f.name}: ${blotType(f.node)}`).join(", ")
          } }`,
      );
    }
  }
  const recordType = (record: RecordSchema) =>
    record.fields.length === 0
      ? `type ${record.typeName} is data = #${record.typeName}`
      : `type ${record.typeName} is data = #${record.typeName} { ${
        record.fields.map((f) => `${f.name}: ${blotType(f.node)}`).join(", ")
      } }`;
  for (const record of [...schema.components, ...schema.resources]) {
    if (record.description) {
      out.line(`// ${record.description.replace(/\n/g, " ")}`);
    }
    out.line(recordType(record));
  }
  out.line(
    `type Entity is data = #Entity { id: U32, parent: U32, name_id: U32${
      schema.components.map((c) => `, ${c.name}: Maybe ${c.typeName}`).join("")
    } }`,
  );
  out.line(
    schema.resources.length === 0
      ? "type Resources is data = #Resources"
      : `type Resources is data = #Resources { ${
        schema.resources.map((r) => `${r.name}: ${r.typeName}`).join(", ")
      } }`,
  );
  out.line(
    "type World is data = #World { tick: U32, next_entity: U32, seed: U32, entities: Array Entity, resources: Resources }",
  );
  const actionType = (lanes: number) =>
    lanes === 3 ? "Button" : lanes === 1 ? "F32" : "Vec2";
  out.line(
    schema.actions.length === 0
      ? "type Actions is data = #Actions"
      : `type Actions is data = #Actions { ${
        schema.actions.map((a) => `${a.name}: ${actionType(a.lanes)}`).join(
          ", ",
        )
      } }`,
  );
  out.line(
    "type PlayerInput is data = #PlayerInput { id: U32, viewport: Vec2, pointer: Pointer, actions: Actions }",
  );
  out.line(
    "type Input is data = #Input { tick: U32, dt: F32, time: F32, viewport: Vec2, pointer: Pointer, actions: Actions, players: Array PlayerInput }",
  );
  if (schema.events.length === 0) {
    out.line("type Event is data = #Silence");
  } else {
    out.line("type Event is data =");
    for (const event of schema.events) {
      out.line(
        event.fields.length === 0
          ? `  | #${event.typeName}`
          : `  | #${event.typeName} { ${
            event.fields.map((f) => `${f.name}: ${blotType(f.node)}`).join(", ")
          } }`,
      );
    }
  }
  out.line();

  // Defaults ------------------------------------------------------------------
  out.line("// Defaults");
  // Blot cannot project a field from a qualified module value
  // (`s.defaults.transform`), so defaults and ids are flat constants.
  for (const c of schema.components) {
    out.line(
      `const default_${c.name} = ${
        recordLiteral(c.typeName, c.fields, defaultExpr)
      }`,
    );
  }
  out.line(
    `const blank = #Entity { id: 0, parent: 0, name_id: 0${
      schema.components.map((c) => `, ${c.name}: #Nothing`).join("")
    } }`,
  );
  out.line(
    schema.resources.length === 0
      ? "const default_resources = #Resources"
      : `const default_resources = #Resources { ${
        schema.resources.map((r) =>
          `${r.name}: ${recordLiteral(r.typeName, r.fields, defaultExpr)}`
        )
          .join(", ")
      } }`,
  );
  out.line();

  // Assets and messages -------------------------------------------------------
  for (const n of schema.names) {
    out.line(
      `const name_${n.name}: U32 = ${n.id} // ${JSON.stringify(n.text)}`,
    );
  }
  const identifiers = assetIdentifiers(catalog);
  const kinds = Object.keys(identifiers).filter((k) =>
    Object.keys(identifiers[k]).length > 0
  )
    .sort();
  if (kinds.length > 0) out.line("// Asset ids by kind; 0 means none.");
  for (const kind of kinds) {
    catalog.assets[kind].forEach((path, i) =>
      out.line(
        `const ${kind}_${identifiers[kind][path]}: U32 = ${i + 1} // ${
          JSON.stringify(path)
        }`,
      )
    );
  }
  // Atlas frames and animations (1-based ids; frame ids double as tile ids),
  // and the tile flags per frame id (see ink/tiles).
  for (const path of catalog.assets.atlas ?? []) {
    const info = catalog.atlases?.[path];
    if (!info) continue;
    const id = identifiers.atlas[path];
    info.frames.forEach((name, i) =>
      out.line(`const frame_${id}_${name.toLowerCase()}: U32 = ${i + 1}`)
    );
    info.animations.forEach((name, i) =>
      out.line(`const anim_${id}_${name.toLowerCase()}: U32 = ${i + 1}`)
    );
    out.line(
      `const tileflags_${id}: Array U32 = #[${
        [0, ...info.frames.map((_, i) => info.tiles[i + 1] ?? 0)].join(", ")
      }]`,
    );
  }
  for (const m of schema.messages) {
    out.line(
      `const message_${m.name}: U32 = ${m.id} // ${JSON.stringify(m.text)}`,
    );
  }
  out.line();

  // Codecs --------------------------------------------------------------------
  out.line("// Codecs");
  for (const type of schema.types) {
    if (type.kind !== "enum") continue;
    const name = snake(type.typeName);
    out.line(`const decode_${name} = fn (n: U32) => case n of`);
    type.values.forEach((v, i) => out.line(`  ${i} => #${pascalValue(v)}`));
    out.line(`  _ => #${pascalValue(type.values[0])}`);
    out.line(
      `const encode_${name} = fn (value: ${type.typeName}) => case value of`,
    );
    type.values.forEach((v, i) =>
      out.line(`  #${pascalValue(v)} => ${f32Literal(i)}`)
    );
  }

  for (const list of lists) {
    const element = list.element;
    const key = elementKey(element);
    const elementType = blotType(element);
    out.line(
      `const decode_list_${key} = fn (v: Array F32) => fn (o: U32) => do:`,
    );
    out.line("  let count = packet.u32 v o");
    out.line(
      `  return @array.generate count (fn index => ${
        readFixed(element, `o + 1 + index * ${element.lanes}`)
      })`,
    );
    out.line(
      `const encode_list_${key} = fn (items: Array ${
        paren(elementType)
      }) => do:`,
    );
    out.line("  let count: F32 = U32.to_f32 items.length");
    out.line(
      `  let rows = array.map (fn (item: ${elementType}) => #[${
        lanesFixed(element, "item").join(", ")
      }]) items`,
    );
    out.line("  return array.flatten #[#[count], ...rows]");
  }

  // Readers and writers for structs, components, resources, events.
  const sizeExpr = (node: Node, offset: string): string => {
    if (node.lanes !== null) return String(node.lanes);
    if (node.kind === "list") {
      return `1 + packet.u32 v ${paren(offset)} * ${node.element.lanes}`;
    }
    return `size_${snake((node as { typeName: string }).typeName)} v ${
      paren(offset)
    }`;
  };
  const readAny = (node: Node, offset: string): string =>
    node.kind === "list"
      ? `decode_list_${elementKey(node.element)} v ${paren(offset)}`
      : readFixed(node, offset);

  const emitRecordCodec = (
    typeName: string,
    fields: { name: string; node: Node }[],
    lanes: number | null,
  ) => {
    const name = snake(typeName);
    if (lanes !== null) {
      let k = 0;
      const parts = fields.map((f) => {
        const expr = `${f.name}: ${readFixed(f.node, at("o", k))}`;
        k += f.node.lanes!;
        return expr;
      });
      out.line(
        `const decode_${name} = fn (v: Array F32) => fn (o: U32) => ${
          parts.length === 0
            ? `#${typeName}`
            : `#${typeName} { ${parts.join(", ")} }`
        }`,
      );
    } else {
      out.line(
        `const decode_${name} = fn (v: Array F32) => fn (o: U32) => do:`,
      );
      out.line("  let at = o");
      for (const f of fields) {
        out.line(`  let f_${f.name} = ${readAny(f.node, "at")}`);
        out.line(`  at := self + ${paren(sizeExpr(f.node, "at"))}`);
      }
      out.line(
        `  return #${typeName} { ${
          fields.map((f) => `${f.name}: f_${f.name}`).join(", ")
        } }`,
      );
      out.line(
        `const size_${name} = fn (v: Array F32) => fn (o: U32) -> U32 => do:`,
      );
      out.line("  let at = o");
      for (const f of fields) {
        out.line(`  at := self + ${paren(sizeExpr(f.node, "at"))}`);
      }
      out.line("  return at - o");
      out.line(
        `const lanes_${name} = fn (value: ${typeName}) -> U32 => ${
          recordLaneCount(fields, "value")
        }`,
      );
    }
    if (fields.length === 0) {
      out.line(
        `const encode_${name} = fn (value: ${typeName}) -> Array F32 => #[]`,
      );
    } else {
      const parts = mergeChunks(
        fields.flatMap((f) => chunks(f.node, `value.${f.name}`)),
      );
      out.line(
        `const encode_${name} = fn (value: ${typeName}) => ${
          parts.length === 1 ? parts[0] : `array.flatten #[${parts.join(", ")}]`
        }`,
      );
    }
  };

  for (const type of schema.types) {
    if (type.kind === "struct") {
      emitRecordCodec(type.typeName, type.fields, type.lanes);
    }
  }
  for (const record of [...schema.components, ...schema.resources]) {
    emitRecordCodec(record.typeName, record.fields, record.lanes);
  }
  out.line();

  // Entities and worlds -------------------------------------------------------
  out.line("const decode_entity = fn (v: Array F32) => fn (o: U32) => do:");
  out.line("  let at = o + 3");
  for (const c of schema.components) {
    const name = snake(c.typeName);
    out.line(
      `  let c_${c.name} = if v[at] == 0.0 then #Nothing else #Some (decode_${name} v (at + 1))`,
    );
    const size = c.lanes !== null
      ? String(1 + c.lanes)
      : `1 + size_${name} v (at + 1)`;
    out.line(`  at := self + (if v[at] == 0.0 then 1 else ${size})`);
  }
  out.line(
    `  return #Entity { id: packet.u32 v o, parent: packet.u32 v (o + 1), name_id: packet.u32 v (o + 2)${
      schema.components.map((c) => `, ${c.name}: c_${c.name}`).join("")
    } }`,
  );
  out.line("const encode_entity = fn (e: Entity) => do:");
  out.line("  let id: F32 = U32.to_f32 e.id");
  out.line("  let parent: F32 = U32.to_f32 e.parent");
  out.line("  let name_id: F32 = U32.to_f32 e.name_id");
  out.line("  return array.flatten #[");
  out.line("    #[id, parent, name_id],");
  for (const c of schema.components) {
    out.line(`    packet.optional encode_${snake(c.typeName)} e.${c.name},`);
  }
  out.line("  ]");

  if (schema.resources.length === 0) {
    out.line(
      "const decode_resources = fn (v: Array F32) => fn (o: U32) => #Resources",
    );
    out.line(
      "const encode_resources = fn (value: Resources) -> Array F32 => #[]",
    );
  } else {
    out.line(
      "const decode_resources = fn (v: Array F32) => fn (o: U32) => do:",
    );
    out.line("  let at = o");
    for (const r of schema.resources) {
      const name = snake(r.typeName);
      out.line(`  let r_${r.name} = decode_${name} v at`);
      out.line(
        `  at := self + ${r.lanes !== null ? r.lanes : `size_${name} v at`}`,
      );
    }
    out.line(
      `  return #Resources { ${
        schema.resources.map((r) => `${r.name}: r_${r.name}`).join(", ")
      } }`,
    );
    out.line(
      `const encode_resources = fn (value: Resources) => array.flatten #[${
        schema.resources.map((r) =>
          `encode_${snake(r.typeName)} value.${r.name}`
        ).join(", ")
      }]`,
    );
  }

  out.block(`
const decode_world = fn (v: Array F32) => fn (base: U32) => do:
  if packet.u32 v base != layout_hash:
    return @panic "state packet was written by a different schema"
  let count = packet.u32 v (base + 5)
  let high = packet.u32 v (base + 3)
  let low = packet.u32 v (base + 4)
  return #World {
    tick: packet.u32 v (base + 1),
    next_entity: packet.u32 v (base + 2),
    seed: (high << 16) | low,
    entities: @array.generate count (fn index => decode_entity v (base + packet.u32 v (base + ${STATE_HEADER} + index))),
    resources: decode_resources v (base + packet.u32 v (base + 6)),
  }

`);
  {
    const sizes = schema.components.map((c) => {
      const some = c.lanes !== null
        ? `1 + ${c.lanes}`
        : `1 + ${recordLaneCount(c.fields, "value")}`;
      return `    at := self + (case e.${c.name} of
      #Some ${c.lanes !== null ? "_" : "value"} => ${some}
      #Nothing => 1)`;
    });
    const writes = schema.components.flatMap((c) => {
      const lines: string[] = [];
      lines.push(`    if let #Some c_${c.name} = e.${c.name}:`);
      lines.push("      out[q] := 1.0");
      const state = { k: 1, n: 0 };
      for (const f of c.fields) {
        emitWrite(lines, "      ", f.node, `c_${c.name}.${f.name}`, state);
      }
      if (state.k > 0) lines.push(`      q := self + ${state.k}`);
      lines.push("    else:");
      lines.push("      q := self + 1");
      return lines;
    });
    const resourceSizes = schema.resources.map((r) =>
      `  at := self + ${recordLaneCount(r.fields, `w.resources.${r.name}`)}`
    );
    const resourceWrites = schema.resources.flatMap((r) => {
      const lines: string[] = [];
      const state = { k: 0, n: 0 };
      for (const f of r.fields) {
        emitWrite(
          lines,
          "  ",
          f.node,
          `w.resources.${r.name}.${f.name}`,
          state,
        );
      }
      if (state.k > 0) lines.push(`  q := self + ${state.k}`);
      return lines;
    });
    out.block(`
// The step result, written in place: the state's lane count, the state packet
// (see codec.ts) and then the events.
const encode_result = fn (w: World) => fn (tail: Array F32) => do:
  let entities = w.entities
  let count = entities.length
  let starts = @array.fill count 0
  let at = ${STATE_HEADER} + count
  for index in 0..count:
    let e = entities[index]
    starts[index] := at
    at := self + 3
${sizes.join("\n")}
  let resources_at = at
${resourceSizes.join("\n")}
  let out = @array.fill (1 + at + tail.length) 0.0
  out[0] := U32.to_f32 at
  out[1] := U32.to_f32 layout_hash
  out[2] := U32.to_f32 w.tick
  out[3] := U32.to_f32 w.next_entity
  out[4] := U32.to_f32 (w.seed >> 16)
  out[5] := U32.to_f32 (w.seed & 65535)
  out[6] := U32.to_f32 count
  out[7] := U32.to_f32 resources_at
  for index in 0..count:
    let e = entities[index]
    let start = starts[index]
    out[${STATE_HEADER + 1} + index] := U32.to_f32 start
    let q = 1 + start
    out[q] := U32.to_f32 e.id
    out[q + 1] := U32.to_f32 e.parent
    out[q + 2] := U32.to_f32 e.name_id
    q := self + 3
${writes.join("\n")}
  let q = 1 + resources_at
${resourceWrites.join("\n")}
  for index in 0..tail.length:
    out[1 + at + index] := tail[index]
  return out
`);
  }

  // Input ---------------------------------------------------------------------
  {
    let k = 0;
    const parts = schema.actions.map((a) => {
      const reader = a.lanes === 3
        ? `packet.button v ${paren(at("o", k))}`
        : a.lanes === 1
        ? `v[${at("o", k)}]`
        : `packet.vec2 v ${paren(at("o", k))}`;
      k += a.lanes;
      return `${a.name}: ${reader}`;
    });
    out.line(
      `const decode_actions = fn (v: Array F32) => fn (o: U32) => ${
        parts.length === 0 ? "#Actions" : `#Actions { ${parts.join(", ")} }`
      }`,
    );
  }
  const singleInput = INPUT_HEADER +
    schema.actions.reduce((n, a) => n + a.lanes, 0);
  out.block(
    `const decode_player_input = fn (v: Array F32) => fn (o: U32) => #PlayerInput {
  id: packet.u32 v o,
  viewport: packet.vec2 v (o + 1),
  pointer: packet.pointer v (o + 3),
  actions: decode_actions v (o + ${INPUT_HEADER - 2}),
}

const decode_input = fn (v: Array F32) => fn (o: U32) => #Input {
  tick: packet.u32 v o,
  dt: v[o + 1],
  time: v[o + 2],
  viewport: packet.vec2 v (o + 3),
  pointer: packet.pointer v (o + 5),
  actions: decode_actions v (o + ${INPUT_HEADER}),
  players: @array.generate (packet.u32 v (o + ${singleInput})) (fn index => decode_player_input v (o + ${
      singleInput + 1
    } + index * ${singleInput - 2})),
}

// Offline games use the ordinary controls. Network games select their owner.
const player_input = fn (input: Input) => fn (id: U32) => do:
  for player in input.players:
    if player.id == id:
      return player
  if input.players.length == 0:
    return #PlayerInput { id: id, viewport: input.viewport, pointer: input.pointer, actions: input.actions }
  return decode_player_input (@array.fill ${singleInput - 2} 0.0) 0
`,
  );

  // Events --------------------------------------------------------------------
  if (schema.events.length === 0) {
    out.line(
      "const encode_events = fn (events: List Event) -> Array F32 => #[0.0]",
    );
  } else {
    out.line("const encode_event = fn (event: Event) => case event of");
    for (const e of schema.events) {
      const pattern = e.fields.length === 0
        ? `#${e.typeName}`
        : `#${e.typeName} { ${
          e.fields.map((f) => `${f.name}: e_${f.name}`).join(", ")
        } }`;
      const parts = mergeChunks([
        `#[${f32Literal(e.index)}]`,
        ...e.fields.flatMap((f) => chunks(f.node, `e_${f.name}`)),
      ]);
      out.line(
        `  ${pattern} => ${
          parts.length === 1 ? parts[0] : `array.flatten #[${parts.join(", ")}]`
        }`,
      );
    }
    out.block(`const encode_events = fn (events: List Event) => do:
  let rows = array.map encode_event (Array.from_list events)
  let count: F32 = U32.to_f32 rows.length
  return array.flatten #[#[count], ...rows]`);
  }
  out.line();

  // Effects, helpers and the runner -------------------------------------------
  out.block(
    `// Effects a step may use. \`emit\` sends an event to the host; \`random\`
// draws from the world's seed.
type Emit is effect = Event -> Unit
type Random is effect = { get: Unit -> U32, set: U32 -> Unit }

const emit = fn (event: Event) => Emit event

// A number in [0, 1).
const random = fn () => do:
  use state <- Random.get ()
  let next = rng.next state
  use Random.set next
  return rng.unit next

// A number in [low, high).
const random_range = fn (low: F32) => fn (high: F32) => do:
  use t <- random ()
  return low + (high - low) * t

const collect = fn computation => do:
  let events: List Event = []
  for request in @requests computation:
    case request of
      effect Emit event =>
        events := [...self, event]
        yield ()
      complete value =>
        return (value, events)

// Run one step: \`update input world\` returns the next world and may use
// emit and random. Games export it as an entry:
//   entry const step = fn (lanes: Array F32) -> Array F32 => s.run update lanes
const run = fn update => fn (lanes: Array F32) -> Array F32 => do:
  let input_lanes = packet.u32 lanes 0
  let input = decode_input lanes 1
  let world = decode_world lanes (1 + input_lanes)
  let (seed, (next, events)) = do (@effect.state Random.get Random.set world.seed):
    return collect (@computation (fn () => update input world))
  let finished: World = next
  finished.seed := seed
  return encode_result finished (encode_events events)

// World helpers. Entities keep their order; ids are never reused.

// Add \`entity\` with a fresh id; returns the id and the world.
const spawn = fn (entity: Entity) => fn (world: World) => do:
  let id = world.next_entity
  entity.id := id
  world.next_entity := self + 1
  world.entities := array.push entity self
  return (id, world)

const find = fn (id: U32) => fn (world: World) => do:
  for entity in world.entities:
    if entity.id == id:
      return #Some entity
  return #Nothing

// Replace the entity with the same id.
const replace = fn (entity: Entity) => fn (world: World) => do:
  world.entities := array.map (fn (other: Entity) => if other.id == entity.id then entity else other) self
  return world

// Apply \`change\` to every entity, in order. \`change\` may use effects.
const each = fn change => fn (world: World) => do:
  let entities = world.entities
  for index in 0..entities.length:
    use next <- change entities[index]
    entities[index] := next
  world.entities := entities
  return world

// Remove an entity and everything parented under it.
const despawn = fn (id: U32) => fn (world: World) => do:
  let entities = world.entities
  let count = entities.length
  let slots = @array.fill world.next_entity 0
  for index in 0..count:
    let entity = entities[index]
    if entity.id < slots.length:
      slots[entity.id] := index + 1
  let dead = @array.fill count #False
  for 0..count:
    let changed = #False
    for index in 0..count:
      let entity = entities[index]
      let parent_dead = if entity.parent != 0 && entity.parent < slots.length && slots[entity.parent] != 0 then dead[slots[entity.parent] - 1] else #False
      if Bool.not dead[index] && (entity.id == id || parent_dead):
        dead[index] := #True
        changed := #True
    if Bool.not changed:
      break
  let kept: List Entity = []
  for index in 0..count:
    if Bool.not dead[index]:
      kept := [...self, entities[index]]
  world.entities := Array.from_list kept
  return world

const children = fn (id: U32) => fn (world: World) =>
  array.filter (fn (entity: Entity) => entity.parent == id) world.entities
`,
  );
  out.block(physicsSection(schema));
  return out.toString();
}
