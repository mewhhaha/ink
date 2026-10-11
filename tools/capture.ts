import { browser } from "../tests/browser-support.ts";

const destination = Deno.args[0] ?? ".cache/captures";
await Deno.mkdir(destination, { recursive: true });
for (
  const [name, page, ready, width, height] of [
    [
      "materials",
      "/examples/graphics.html",
      "globalThis.inkGraphics?.frames >= 16",
      1100,
      900,
    ],
    [
      "materials-mobile",
      "/examples/graphics.html",
      "globalThis.inkGraphics?.frames >= 16",
      390,
      1100,
    ],
    [
      "controls",
      "/examples/browser-ui.html",
      "globalThis.inkReady === true",
      1100,
      900,
    ],
  ] as const
) {
  const instance = await browser(page, width, height);
  try {
    await instance.waitFor(ready, 30000);
    const overflow = await instance.evaluate<boolean>(
      "document.documentElement.scrollWidth > innerWidth",
    );
    if (overflow) throw new Error(`${name}: horizontal overflow`);
    if (name.startsWith("materials")) {
      const failure = await instance.evaluate<string>(
        "document.querySelector('#error').textContent",
      );
      if (failure) throw new Error(failure);
    }
    await instance.screenshot(`${destination}/${name}.png`);
    console.log(`${destination}/${name}.png`);
  } finally {
    await instance.dispose();
  }
}
