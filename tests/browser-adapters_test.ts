import { assertEquals } from "@std/assert";
import { browser } from "./browser-support.ts";
Deno.test("real Chromium keyboard, accessibility tree, input and offline audio", async () => {
  const page = await browser("/tests/browser-adapters.html");
  try {
    await page.waitFor("globalThis.inkReady === true");
    await page.evaluate("document.getElementById('open').focus()");
    await page.key("Enter", "Enter", 13);
    assertEquals(await page.evaluate("document.activeElement.id"), "resume");
    await page.evaluate("document.getElementById('trigger').focus()");
    await page.key("ArrowDown", "ArrowDown", 40);
    assertEquals(await page.evaluate("document.activeElement.id"), "first");
    const dialogTree = await page.command<
      { nodes: { role?: { value: string }; name?: { value: string } }[] }
    >("Accessibility.getFullAXTree");
    assertEquals(
      dialogTree.nodes.some((node) =>
        node.role?.value === "dialog" && node.name?.value === "Pause station"
      ),
      true,
    );
    assertEquals(
      dialogTree.nodes.some((node) =>
        node.role?.value === "menu" && node.name?.value === "Actions"
      ),
      true,
    );
    await page.key("ArrowDown", "ArrowDown", 40);
    assertEquals(await page.evaluate("document.activeElement.id"), "last");
    await page.key("Home", "Home", 36);
    assertEquals(await page.evaluate("document.activeElement.id"), "first");
    await page.key("b", "KeyB", 66);
    assertEquals(await page.evaluate("document.activeElement.id"), "last");
    await page.key("Enter", "Enter", 13);
    assertEquals(await page.evaluate("witnesses.selected()"), "last");
    assertEquals(await page.evaluate("document.activeElement.id"), "trigger");
    await page.key("ArrowUp", "ArrowUp", 38);
    assertEquals(await page.evaluate("document.activeElement.id"), "last");
    await page.key("Tab", "Tab", 9);
    assertEquals(await page.evaluate("document.activeElement.id"), "resume");
    await page.key("Escape", "Escape", 27);
    await page.waitFor("document.activeElement.id === 'open'");
    await page.evaluate("document.getElementById('inventory').focus()");
    await page.key("ArrowDown", "ArrowDown", 40);
    assertEquals(await page.evaluate("witnesses.inventory()"), ["two"]);
    await page.evaluate("document.getElementById('scale').focus()");
    await page.key("ArrowRight", "ArrowRight", 39);
    assertEquals(await page.evaluate("witnesses.scale()"), 101);
    const tree = await page.command<
      { nodes: { role?: { value: string }; name?: { value: string } }[] }
    >("Accessibility.getFullAXTree");
    const named = tree.nodes.map((
      node,
    ) => [node.role?.value, node.name?.value]);
    assertEquals(
      named.some(([role, name]) => role === "listbox" && name === "Inventory"),
      true,
    );
    assertEquals(
      named.some(([role, name]) => role === "slider" && name === "UI scale"),
      true,
    );
    assertEquals(await page.evaluate("witnesses.testInput()"), true);
    assertEquals(await page.evaluate("witnesses.testPreferences()"), true);
    assertEquals(await page.evaluate("witnesses.testNavigation()"), true);
    const audio = await page.evaluate<{ peak: number; stopped: number }>(
      "witnesses.testAudio()",
    );
    assertEquals(Math.abs(audio.peak - 0.5) < 0.003, true);
    assertEquals(audio.stopped, 0);
    await page.evaluate("witnesses.dispose()");
    const lifetimes = await page.evaluate<
      {
        cycles: number;
        peakListeners: number;
        peakConnections: number;
        remainingListeners: number;
        remainingConnections: number;
        retainedBuffers: number;
        callbacks: number;
      }
    >("witnesses.testLifetimes()");
    assertEquals(lifetimes.cycles, 100);
    assertEquals(lifetimes.peakListeners > 10, true);
    assertEquals(lifetimes.peakConnections, 4);
    assertEquals(lifetimes.remainingListeners, 0);
    assertEquals(lifetimes.remainingConnections, 0);
    assertEquals(lifetimes.retainedBuffers, 0);
    assertEquals(lifetimes.callbacks, 300);
  } finally {
    await page.dispose();
  }
});
