/** Browser jobs stay rooted in the page while GPU and asset promises settle. */
import type { Page } from "playwright-core";
import type {
  CaptureOptions,
  CaptureResult,
  InkAutomation,
  RunOptions,
} from "./automation.ts";
import type { Scenario, ScenarioResult } from "@ink/core";
import type { SceneFile } from "@ink/schema";

interface Calls {
  ready: { args: undefined; result: void };
  capture: { args: CaptureOptions; result: CaptureResult };
  run: { args: RunOptions; result: SceneFile };
  scenario: {
    args: { scenario: Scenario; updateGoldens?: boolean };
    result: ScenarioResult;
  };
}
interface Job {
  done: boolean;
  result?: unknown;
  error?: string;
  pending?: Promise<void>;
}
interface BrowserGlobal {
  __ink: InkAutomation;
  __inkJobs?: Record<string, Job>;
}

export async function callAutomation<M extends keyof Calls>(
  page: Page,
  method: M,
  args: Calls[M]["args"],
): Promise<Calls[M]["result"]> {
  const id = crypto.randomUUID();
  // CI reported "Resulting promise was garbage collected" during GPU work.
  // Own each pending job in the page and poll its completion explicitly.
  await page.evaluate(({ id, method, args }) => {
    const global = globalThis as unknown as BrowserGlobal;
    const job: Job = { done: false };
    (global.__inkJobs ??= {})[id] = job;
    job.pending = Promise.resolve().then<unknown>(() => {
      const api = global.__ink;
      switch (method) {
        case "ready":
          return api.ready;
        case "capture":
          return api.capture(args as CaptureOptions);
        case "run":
          return api.run(args as RunOptions);
        case "scenario":
          return api.scenario(args as Calls["scenario"]["args"]);
      }
    }).then((result) => {
      job.result = result;
      job.done = true;
    }, (error) => {
      job.error = error instanceof Error
        ? error.stack ?? error.message
        : String(error);
      job.done = true;
    });
  }, { id, method, args });
  try {
    await page.waitForFunction(
      (id) => (globalThis as unknown as BrowserGlobal).__inkJobs?.[id]?.done,
      id,
      { timeout: 120000 },
    );
    return await page.evaluate((id) => {
      const job = (globalThis as unknown as BrowserGlobal).__inkJobs![id];
      if (job.error) throw new Error(job.error);
      return job.result;
    }, id) as Calls[M]["result"];
  } finally {
    await page.evaluate((id) => {
      delete (globalThis as unknown as BrowserGlobal).__inkJobs?.[id];
    }, id).catch(() => {});
  }
}
