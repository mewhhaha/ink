import { assertEquals } from "@std/assert";
import { compile } from "./support.ts";
Deno.test("localized text adapter leaves vocabulary and plural selection to callers", async () => {
  const fixture = await compile(new URL("./locale-pen.blot", import.meta.url), {
    "pen/": new URL("./fixtures/pen/", import.meta.url),
  });
  try {
    const result = fixture.guest.call(
      "test_locale_adapter_preserves_drawn_spoken_and_request_arguments",
      null,
    ) as Float32Array;
    assertEquals(result[1], 0, Array.from(result).join());
  } finally {
    await fixture.dispose();
  }
});
