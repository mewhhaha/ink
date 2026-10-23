import { assertEquals, assertThrows } from "@std/assert";
import { compile } from "./support.ts";
const fixture = await compile(new URL("./word-persist.blot", import.meta.url));
const { guest } = fixture;
Deno.test("word-native host saves preserve U32 identities, snapshots, sparse columns and old worlds", () => {
  for (const count of [0, 1, 3, 256, 1024]) {
    assertEquals(
      guest.call("roundtrip", count),
      new Uint32Array([
        1,
        count,
        9,
        7,
        count * (count - 1) / 2 + count * 10,
        0,
        0xffffffff,
      ]),
    );
    assertEquals(
      guest.call("roundtrip", count),
      guest.call("bridge_roundtrip", count),
    );
    const saved = guest.call("save", count) as Uint32Array;
    assertEquals(saved.includes(0x80000000), true);
    // A byte-preserving host boundary, with no F32 numeric conversion.
    const bytes = saved.buffer.slice(
      saved.byteOffset,
      saved.byteOffset + saved.byteLength,
    );
    assertEquals(
      guest.call("restore", new Uint32Array(bytes)),
      new Uint32Array([
        count,
        9,
        7,
        count * (count - 1) / 2 + count * 10,
        0,
        0xffffffff,
      ]),
    );
  }
  assertEquals(
    guest.call("scene_restore", null),
    new Uint32Array([3, 42, 7, 33, 10, 0xffffffff]),
  );
  assertEquals(
    guest.call("migration", null),
    new Uint32Array([1, 3, 109, 107, 33, 0, 0xffffffff]),
  );
});
Deno.test("word-native state rejects truncated frames, duplicate sections and malformed sparse columns", () => {
  const saved = guest.call("save", 3) as Uint32Array;
  for (let end = 0; end < saved.length; end++) {
    assertThrows(() => guest.call("restore", saved.slice(0, end)));
  }
  assertThrows(() => guest.call("restore", new Uint32Array([...saved, 0])));
  for (
    const [at, value] of [[0, 0], [1, 0], [2, 0xffffffff], [5, 0xffffffff], [
      6,
      2,
    ]]
  ) {
    const bad = saved.slice();
    bad[at] = value;
    assertThrows(() => guest.call("restore", bad));
  }
  let cursor = 3;
  const sections: number[] = [];
  for (let i = 0; i < saved[2]; i++) {
    sections.push(cursor);
    cursor += 3 + saved[cursor + 2];
  }
  const duplicate = saved.slice();
  duplicate[sections[1]] = 0;
  assertThrows(() => guest.call("restore", duplicate));
  const column = sections.find((at) => saved[at] === 101)!;
  for (
    const [at, value] of [[column + 3, 2], [column + 4, 0xffffffff], [
      column + 5,
      3,
    ], [column + 6, 0xffffffff]]
  ) {
    const bad = saved.slice();
    bad[at] = value;
    assertThrows(() => guest.call("restore", bad));
  }
});
Deno.test.afterAll(() => fixture.dispose());
