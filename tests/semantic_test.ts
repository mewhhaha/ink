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
