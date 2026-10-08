/** Launch the actual packaged application, with no Vite or HTTP server. */
import { _electron as electron } from "playwright-core";
import { assert, assertEquals } from "@std/assert";
import { resolve } from "@std/path";
import type { bootPlayer } from "@ink/player";

const profile = await Deno.makeTempDir({ prefix: "ink-desktop-test-" });
const application = await electron.launch({
  executablePath: resolve(
    Deno.args[0] ?? "examples/feel/dist-desktop/ink-game-linux-x64/ink-game",
  ),
  args: [
    "--ink-automation",
    `--user-data-dir=${profile}`,
  ],
  env: {
    ...Deno.env.toObject(),
    XDG_CONFIG_HOME: profile,
    XDG_CACHE_HOME: profile,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
  },
});
try {
  const page = await application.firstWindow();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.error(m.text());
  });
  await page.waitForFunction(
    () =>
      document.querySelector("dialog") ||
      document.body.innerText.includes("Could not start"),
    null,
    { timeout: 45000 },
  );
  await page.screenshot({ path: "tmp/player-desktop-start.png" });
  assert(
    !await page.locator("body").innerText().then((text) =>
      text.includes("Could not start")
    ),
    "desktop renderer started",
  );
  await page.getByRole("button", { name: "Play", exact: true }).click();
  assert(page.url().startsWith("ink-game://game/"));
  await page.waitForFunction(async () =>
    (await (globalThis as unknown as {
      __inkPlayer: ReturnType<typeof bootPlayer>;
    }).__inkPlayer).player.tick >= 30
  );
  await page.keyboard.press("Space");
  await page.waitForFunction(async () =>
    Number(
      (await (globalThis as unknown as {
        __inkPlayer: ReturnType<typeof bootPlayer>;
      }).__inkPlayer).player.world.resources.run.jumps,
    ) > 0
  );
  await page.screenshot({ path: "tmp/player-desktop.png" });
  const litPixels = await page.evaluate(async () => {
    const { view } = await (globalThis as unknown as {
      __inkPlayer: ReturnType<typeof bootPlayer>;
    }).__inkPlayer;
    const pixels = await view.readPixels();
    let lit = 0;
    for (let i = 0; i < pixels.data.length; i += 4) {
      if (pixels.data[i] + pixels.data[i + 1] + pixels.data[i + 2] > 30) lit++;
    }
    return lit / (pixels.width * pixels.height);
  });
  assert(
    litPixels > 0.9,
    "desktop game framebuffer contains the rendered scene",
  );
  assertEquals(errors, []);
  console.log(
    "✓ packaged desktop game loads, plays and jumps without an editor server",
  );
} finally {
  await application.close();
  await Deno.remove(profile, { recursive: true });
}
