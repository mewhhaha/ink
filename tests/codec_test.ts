import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { compile } from "./support.ts";
import { generate } from "../tools/derive.ts";
import { fileURLToPath } from "node:url";
import { instantiateGuest } from "@mewhhaha/blot";
import { derivation } from "../tools/derive-runtime.ts";
import { codecBuffers } from "../tools/derive-buffers.ts";
const fixture = await compile(new URL("./codec.blot", import.meta.url));
const { guest } = fixture;
const array = (
  name: string,
  value: number | null | Uint32Array | Float32Array = null,
) => Array.from(guest.call(name, value) as Uint32Array);
Deno.test("derived records, variants, nested collections and validated fields persist current and previous state", () => {
  assertEquals(array("persistence"), [16777219, 4294967295, 16777217, 3, 3]);
  assertEquals(array("inspection"), [30]);
  assertEquals(array("migration"), [4294967295, 0, 4294967295]);
});
Deno.test("word adapters preserve every integer bit and finite float representation", () => {
  const words = new Uint32Array([0, 16777217, 0x80000000, 0xffffffff]);
  const packed = guest.call("packed", words) as Float32Array;
  assertEquals(array("unpacked", packed), Array.from(words));
  for (
    const value of [-0, 0, -0.125, 0.375, Math.fround(1e-40), Math.fround(3e38)]
  ) {
    const encoded = guest.call("float_bits", value) as Uint32Array;
    const expected = new Uint32Array(new Float32Array([value]).buffer);
    assertEquals(encoded, expected);
    const read = guest.call("float_read", encoded) as Float32Array;
    assertEquals(read[0], 1);
    assertEquals(Object.is(read[1], value), true);
  }
  for (const value of [NaN, Infinity, -Infinity]) {
    assertThrows(() => guest.call("float_bits", value));
  }
  for (const bits of [0x7f800000, 0xff800000, 0x7fc00001]) {
    assertEquals(array("float_read", new Uint32Array([bits])), [0]);
  }
  for (const value of [NaN, Infinity, -1, 65536, 0.5]) {
    const bad = packed.slice();
    bad[3] = value;
    assertEquals(array("unpacked", bad), []);
  }
});
Deno.test("derived decoders reject malformed tags, counts, lengths, versions and trailing words", () => {
  const saved = guest.call("encoded", 0xffffffff) as Uint32Array;
  assertEquals(array("decoded", saved), [1, 0xffffffff, 16777217]);
  for (let end = 0; end < saved.length; end++) {
    assertEquals(array("decoded", saved.slice(0, end)), [0]);
  }
  assertEquals(array("decoded", new Uint32Array([...saved, 0])), [0]);
  for (
    const [at, value] of [[0, 2], [1, 9], [2, 8], [3, 99], [4, 0xffffffff], [
      14,
      0x7f800000,
    ]]
  ) {
    const bad = saved.slice();
    bad[at] = value;
    assertEquals(array("decoded", bad), [0]);
  }
});
Deno.test("generated sources are reproducible and checked against a published layout", async () => {
  const base = new URL("./fixtures/derived/", import.meta.url);
  const options = {
    source: fileURLToPath(new URL("model.blot", base)),
    schema: fileURLToPath(new URL("schema.json", base)),
    output: fileURLToPath(new URL("model_derived.blot", base)),
    published: fileURLToPath(new URL("published.json", base)),
    check: true,
  };
  await generate(options);
  const temporary = await Deno.makeTempFile({ suffix: ".json" });
  try {
    const schema = JSON.parse(await Deno.readTextFile(options.schema));
    schema.types.Site.variants.Site.fields.kind = 31;
    await Deno.writeTextFile(temporary, JSON.stringify(schema));
    await assertRejects(
      () => generate({ ...options, schema: temporary }),
      Error,
      "without a codec version change",
    );
  } finally {
    await Deno.remove(temporary);
  }
});
Deno.test("custom validation rejects invalid values; stable field ids survive declaration reordering", async () => {
  const words = guest.call("delivery_encode", null) as Uint32Array;
  assertEquals(guest.call("delivery_decode", words), 1);
  words[words.length - 1] = 0;
  assertEquals(guest.call("delivery_decode", words), 0);
  const directory = await Deno.makeTempDir();
  try {
    const base = new URL("./fixtures/derived/", import.meta.url);
    const source = (await Deno.readTextFile(new URL("model.blot", base)))
      .replace(
        "ring: U32, sector: U32, kind: U32, age: F32, work: U32, impact: F32, delivered: U32",
        "delivered: U32, impact: F32, work: U32, age: F32, kind: U32, sector: U32, ring: U32",
      );
    const options = {
      source: `${directory}/model.blot`,
      schema: fileURLToPath(new URL("schema.json", base)),
      output: `${directory}/generated.blot`,
      published: fileURLToPath(new URL("published.json", base)),
    };
    await Deno.writeTextFile(options.source, source);
    await generate(options);
    await generate({ ...options, check: true });
    await Deno.writeTextFile(
      `${directory}/entry.blot`,
      `import * as m from "./generated"
import * as c from "ink/codec"
entry const encoded = fn () => c.encode (#m.Site { delivered: 4, impact: 0.375, work: 100, age: -0.125, kind: 4294967295, sector: 7, ring: 16777217 })
`,
    );
    const reordered = await compile(new URL(`file://${directory}/entry.blot`));
    try {
      assertEquals(
        reordered.guest.call("encoded", null),
        guest.call("encoded", 0xffffffff),
      );
    } finally {
      await reordered.dispose();
    }
    await Deno.writeTextFile(options.output, "// stale\n", { append: true });
    await assertRejects(
      () => generate({ ...options, check: true }),
      Error,
      "Stale generated output",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
Deno.test("optimized codecs retain upstream words and malformed-input decisions", async () => {
  const base = new URL("./fixtures/derived/", import.meta.url);
  const { dataShapes, deriveCodec } = await derivation();
  const shapes = await dataShapes(
    await Deno.readTextFile(new URL("model.blot", base)),
  );
  const schema = JSON.parse(
    await Deno.readTextFile(new URL("schema.json", base)),
  );
  const path = fileURLToPath(new URL("model_derived.blot", base));
  let upstream = await Deno.readTextFile(path);
  for (const shape of shapes) {
    const plan = schema.types[shape.name];
    if (!plan) continue;
    const original = deriveCodec(shape, plan);
    const optimized = codecBuffers(shape, plan, original);
    assertStringIncludes(upstream, optimized);
    upstream = upstream.replace(optimized, original);
  }
  const built = await fixture.compiler.build({ sources: { [path]: upstream } });
  if (!built.success) throw new Error(JSON.stringify(built.diagnostics));
  const reference = await instantiateGuest(built.bytes);
  try {
    for (let choice = 0; choice < 5; choice++) {
      const saved = guest.call("sample_words", choice) as Uint32Array;
      assertEquals(saved, reference.call("sample_words", choice));
      const compare = (words: Uint32Array) => {
        const packet = new Uint32Array([choice, ...words]);
        assertEquals(
          guest.call("read_sample", packet),
          reference.call("read_sample", packet),
        );
      };
      compare(saved);
      for (let end = 0; end < saved.length; end++) compare(saved.slice(0, end));
      compare(new Uint32Array([...saved, 0]));
      for (let at = 0; at < saved.length; at++) {
        for (const value of [0, 1, 0x7f800000, 0xffffffff]) {
          const bad = saved.slice();
          bad[at] = value;
          compare(bad);
        }
      }
    }
  } finally {
    reference.dispose();
  }
});
Deno.test.afterAll(() => fixture.dispose());
