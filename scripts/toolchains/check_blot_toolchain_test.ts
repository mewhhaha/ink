import { assertEquals, assertThrows } from "@std/assert";
import { parse_blot_toolchain } from "./check_blot_toolchain.ts";

Deno.test("local Blot toolchains select the sibling working tree", () => {
  assertEquals(
    parse_blot_toolchain('{"kind":"local","repository":"../blot"}'),
    { kind: "local", repository: "../blot" },
  );
});

Deno.test("pinned Blot toolchains require an exact Git revision", () => {
  assertEquals(
    parse_blot_toolchain(
      '{"kind":"pinned","repository":"../blot","revision":"df4f699048dec6d770704a0a02fba5ef2bbb89c0"}',
    ),
    {
      kind: "pinned",
      repository: "../blot",
      revision: "df4f699048dec6d770704a0a02fba5ef2bbb89c0",
    },
  );
});

Deno.test("Blot toolchain manifests reject unsupported modes", () => {
  assertThrows(
    () => parse_blot_toolchain('{"kind":"remote","repository":"../blot"}'),
    Error,
    'kind must be "local" or "pinned"; received "remote"',
  );
});
