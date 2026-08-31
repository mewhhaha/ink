import { assertEquals, assertRejects } from "@std/assert";
import { digest_bytes } from "../packages/assets/src/digest.ts";
import { choose_content_addressed_publication } from "./build_lighting_assets.ts";

Deno.test("lighting publication replaces corrupted bytes at a digest path", async () => {
  const staged_bytes = new Uint8Array([1, 2, 3]);
  const digest = await digest_bytes(staged_bytes);
  const relative_path = `assets/.ink/${digest.slice("sha256:".length)}`;

  assertEquals(
    await choose_content_addressed_publication({
      relative_path,
      staged_bytes,
      published_bytes: new Uint8Array([9, 9, 9]),
    }),
    "replace",
  );
  assertEquals(
    await choose_content_addressed_publication({
      relative_path,
      staged_bytes,
      published_bytes: staged_bytes,
    }),
    "reuse",
  );
});

Deno.test("lighting publication rejects staged bytes that do not match their path", async () => {
  const expected = await digest_bytes(new Uint8Array([1]));
  const relative_path = `prepared/manifests/${
    expected.slice("sha256:".length)
  }.json`;

  await assertRejects(
    () =>
      choose_content_addressed_publication({
        relative_path,
        staged_bytes: new Uint8Array([2]),
        published_bytes: undefined,
      }),
    Error,
    `lighting staged publication ${JSON.stringify(relative_path)} has digest`,
  );
});
