import { assertEquals, assertNotStrictEquals, assertThrows } from "@std/assert";
import { parse_game_artifact } from "./artifact.ts";

Deno.test("artifact parsing copies Wasm and preserves precise declarations", () => {
  const wasm = new Uint8Array([0, 97, 115, 109]);
  const artifact = parse_game_artifact({
    guest_id: " game ",
    artifact_digest: "artifact-1",
    schema_digest: "schema-1",
    wasm,
    capabilities: [
      { id: "graphics", availability: "optional" },
      { id: "storage", availability: "required" },
    ],
  });
  wasm[0] = 9;
  assertEquals(artifact, {
    guest_id: "game",
    artifact_digest: "artifact-1",
    schema_digest: "schema-1",
    wasm: new Uint8Array([0, 97, 115, 109]),
    capabilities: [
      { id: "graphics", availability: "optional" },
      { id: "storage", availability: "required" },
    ],
  });
  assertNotStrictEquals(artifact.wasm, wasm);
});

Deno.test("artifact parsing rejects duplicate capability identities", () => {
  assertThrows(
    () =>
      parse_game_artifact({
        guest_id: "game",
        artifact_digest: "artifact-1",
        schema_digest: "schema-1",
        wasm: new Uint8Array([1]),
        capabilities: [
          { id: "storage", availability: "required" },
          { id: "storage", availability: "optional" },
        ],
      }),
    Error,
    'game artifact "game" declares capability "storage" more than once',
  );
});

Deno.test("artifact parsing identifies malformed boundary fields", () => {
  assertThrows(
    () =>
      parse_game_artifact({
        guest_id: "game",
        artifact_digest: "artifact-1",
        schema_digest: "schema-1",
        wasm: [],
        capabilities: [],
      }),
    Error,
    'game artifact "game" Wasm must be a nonempty Uint8Array; received []',
  );
});
