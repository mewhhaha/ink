import { assert, assertEquals, assertThrows } from "@std/assert";
import { parse_wad } from "./wad.ts";

Deno.test("reads the Freedoom Phase 1 WAD directory", async () => {
  const bytes = await Deno.readFile(
    new URL(
      "../assets/freedoom/release/freedoom-0.13.0/freedoom1.wad",
      import.meta.url,
    ),
  );
  const wad = parse_wad(bytes);

  assertEquals(wad.kind, "IWAD");
  assert(wad.lumps.length > 3000);
  assert(wad.find("TITLEPIC") !== undefined);
  assert(wad.find("PLAYPAL") !== undefined);
  assert(wad.find("COLORMAP") !== undefined);
  assert(wad.find("TEXTURE1") !== undefined);
  assert(wad.find("D_E1M1") !== undefined);
  assert(wad.find("DSPISTOL") !== undefined);
  assert(wad.find("TITLEPIC")!.size > 0);
  assertEquals(wad.read("PLAYPAL").length, 14 * 768);
});

Deno.test("preserves repeated WAD lump order", () => {
  const bytes = new Uint8Array(12 + 16 * 2);
  bytes.set(new TextEncoder().encode("PWAD"), 0);
  new DataView(bytes.buffer).setInt32(4, 2, true);
  new DataView(bytes.buffer).setInt32(8, 12, true);
  bytes.set(new TextEncoder().encode("TEST"), 20);
  bytes.set(new TextEncoder().encode("TEST"), 36);

  const wad = parse_wad(bytes);
  assertEquals(wad.find("test", 0)?.index, 0);
  assertEquals(wad.find("test", 1)?.index, 1);
  assertEquals(wad.find("test", 2), undefined);
});

Deno.test("rejects malformed WAD headers", () => {
  assertThrows(
    () => parse_wad(new Uint8Array(11)),
    Error,
    "12-byte header",
  );
  const bytes = new Uint8Array(12);
  bytes.set(new TextEncoder().encode("NOPE"), 0);
  assertThrows(() => parse_wad(bytes), Error, "Unsupported WAD type");
});
