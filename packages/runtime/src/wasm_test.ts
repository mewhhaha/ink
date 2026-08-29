import { assertEquals, assertRejects } from "@std/assert";
import { parse_game_artifact } from "./artifact.ts";
import { instantiate_wasm_guest } from "./wasm.ts";

Deno.test("Wasm loading leaves the guest ABI to an explicit adapter", async () => {
  const artifact = parse_game_artifact({
    guest_id: "wasm-guest",
    artifact_digest: "artifact-1",
    schema_digest: "schema-1",
    wasm: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
    capabilities: [],
  });
  let adapted = false;
  const guest = await instantiate_wasm_guest(artifact, {}, {
    create: (instance, loaded_artifact) => {
      adapted = instance instanceof WebAssembly.Instance;
      return {
        artifact: loaded_artifact,
        blocks: [],
        reset: () => {},
        advance: () => {},
        observe: (_query: string) => 0,
        snapshot: () => new Uint8Array(),
        restore: () => {},
        close: () => {},
      };
    },
  });
  assertEquals(adapted, true);
  assertEquals(guest.artifact.artifact_digest, "artifact-1");
});

Deno.test("malformed Wasm identifies the guest and artifact", async () => {
  const artifact = parse_game_artifact({
    guest_id: "wasm-guest",
    artifact_digest: "broken-artifact",
    schema_digest: "schema-1",
    wasm: new Uint8Array([1]),
    capabilities: [],
  });
  await assertRejects(
    () =>
      instantiate_wasm_guest(artifact, {}, {
        create: () => {
          throw new Error("adapter must not run");
        },
      }),
    Error,
    'guest "wasm-guest" artifact "broken-artifact" failed WebAssembly instantiation',
  );
});
