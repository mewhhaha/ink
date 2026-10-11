import { assert, assertEquals } from "@std/assert";
import { browser } from "./browser-support.ts";

Deno.test("WebGPU selected passes, retained allocations, ownership and 1080p memory witnesses", async () => {
  const page = await browser("/tests/gpu-browser.html");
  try {
    await page.waitFor("globalThis.inkReady === true");
    const report = await page.evaluate<{
      startup: {
        selected: { render: number; compute: number };
        all: { render: number; compute: number };
      };
      allocations: {
        cold: { groups: number; views: number };
        retained: { groups: number; views: number };
        avoidedFraction: number;
      };
      resourceAudit: { cycles: number; live: number };
      footprint: { reduction: number };
      uniformStagingReused: boolean;
    }>(
      "import('/tests/gpu-maintenance.ts').then(module => module.maintenance())",
    );
    assertEquals(report.startup.selected.render, 0);
    assertEquals(report.startup.selected.compute, 3);
    assertEquals(report.allocations.retained, { groups: 0, views: 0 });
    assert(report.allocations.avoidedFraction >= 0.8);
    assertEquals(report.resourceAudit.cycles, 100);
    assertEquals(report.resourceAudit.live, 0);
    assertEquals(report.uniformStagingReused, true);
    assert(report.footprint.reduction >= 0.24);
    console.log(JSON.stringify(report));
  } finally {
    await page.dispose();
  }
});
