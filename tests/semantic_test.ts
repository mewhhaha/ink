import { assertEquals } from "@std/assert";
import { compile } from "./support.ts";

Deno.test("semantic publications preserve Unicode, exact identity words and optional values", async () => {
  const fixture = await compile(new URL("./semantic.blot", import.meta.url), {
    "pen/": new URL("./fixtures/pen/", import.meta.url),
  });
  try {
    const lanes = fixture.guest.call("observation", 4294967295) as Float32Array;
    const value = JSON.parse(new TextDecoder().decode(Uint8Array.from(lanes)));
    assertEquals(value.tick, "4294967295");
    assertEquals(value.objects[0].id.words, [4294967295, 16777217]);
    assertEquals(
      value.objects[0].fields.map((f: { value: unknown }) => f.value),
      [
        { kind: "unsigned", value: 4294967295 },
        { kind: "encoded", value: [2147483648, 1] },
        { kind: "boolean", value: true },
      ],
    );
    assertEquals(value.schema.types[0].label, "Żuraw 👾");
    assertEquals(value.decisions[0].reason, 'Quoted "line"\\path\n👾');
    const quoted = fixture.guest.call("escaped", null) as Uint32Array;
    assertEquals(JSON.parse(String.fromCodePoint(...quoted)), "start 👾 end");
  } finally {
    await fixture.dispose();
  }
});

Deno.test("derived semantic schemas and projections preserve exact words", async () => {
  const fixture = await compile(new URL("./semantic.blot", import.meta.url), {
    "pen/": new URL("./fixtures/pen/", import.meta.url),
  });
  try {
    const lanes = fixture.guest.call(
      "derived_observation",
      null,
    ) as Float32Array;
    const value = JSON.parse(new TextDecoder().decode(Uint8Array.from(lanes)));
    const described = value.schema.types[0].descriptor.variants[0];
    const object = value.objects[0];
    assertEquals(object.tag, described.tag);
    assertEquals(object.id.words, [4294967295]);
    assertEquals(described.fields.map((f: { id: number }) => f.id), [
      10,
      20,
      30,
      40,
      50,
      60,
      70,
    ]);
    assertEquals(object.fields.map((f: { id: number }) => f.id), [
      10,
      20,
      30,
      40,
      50,
      60,
      70,
    ]);
    assertEquals(object.fields.map((f: { value: unknown }) => f.value), [
      { kind: "unsigned", value: 16777217 },
      { kind: "unsigned", value: 7 },
      { kind: "unsigned", value: 4294967295 },
      { kind: "encoded", value: [3187671040] },
      { kind: "unsigned", value: 100 },
      { kind: "encoded", value: [1052770304] },
      { kind: "unsigned", value: 4 },
    ]);
    assertEquals(
      described.fields.map((f: { kind: string }) => f.kind),
      object.fields.map((f: { value: { kind: string } }) => f.value.kind),
    );
  } finally {
    await fixture.dispose();
  }
});
