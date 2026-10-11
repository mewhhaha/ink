import { assertEquals } from "@std/assert";
import { browser } from "./browser-support.ts";
import { numericCorpus } from "./numeric-corpus.ts";
Deno.test("shipped GPU helpers match Blot and independent seeded numerical references", async () => {
  const corpus = await numericCorpus();
  const page = await browser("/tests/gpu-browser.html");
  try {
    await page.waitFor("globalThis.inkReady === true");
    const report = await page.evaluate<
      Record<
        string,
        { rows: number; maxRelativeError: number; maxAbsoluteError: number }
      >
    >(
      `import('/tests/gpu-parity.ts').then(module => module.parity(${
        JSON.stringify(corpus)
      }))`,
    );
    assertEquals(Object.keys(report).sort(), [
      "brdf",
      "color",
      "projection",
      "splits",
    ]);
    for (const [family, result] of Object.entries(report)) {
      assertEquals(result.rows, corpus[family as keyof typeof corpus].length);
    }
    console.log(JSON.stringify(report));
  } finally {
    await page.dispose();
  }
});
