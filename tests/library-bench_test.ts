import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { runWorkload, workloads } from "../tools/library-bench.ts";
import { modules } from "../mod.ts";

const workerSource = (source: string) =>
  new URL(`data:application/javascript,${encodeURIComponent(source)}`);

Deno.test("every shipped Blot module has a measured workload", () => {
  assertEquals(
    [...new Set(workloads.flatMap((item) => item.modules))].sort(),
    [...modules].sort(),
  );
});

Deno.test("benchmark waits for worker imports before sending input", async () => {
  const result = await runWorkload(
    workloads[0],
    new Uint8Array(),
    2000,
    workerSource(`
      await new Promise(resolve => setTimeout(resolve, 50));
      self.onmessage = event => self.postMessage({ received: event.data.workload.name });
      self.postMessage({ ready: true });
    `),
  );
  assertEquals(result.received, "math");
});

Deno.test("[stress] benchmark terminates a stalled synchronous Wasm worker", async () => {
  const error = await assertRejects(
    () =>
      runWorkload(
        workloads[0],
        new Uint8Array(),
        500,
        workerSource(`
          self.onmessage = () => {
            // One exported () -> () function: loop { br 0 }.
            const bytes = new Uint8Array([
              0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,
              7,9,1,5,115,116,97,108,108,0,0,10,9,1,7,0,3,64,12,0,11,11
            ]);
            const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes));
            self.postMessage({ progress: "calling stalled Wasm" });
            instance.exports.stall();
          };
          self.postMessage({ ready: true });
        `),
      ),
    Error,
    "exceeded 500ms; terminated",
  );
  assertStringIncludes(error.message, "calling stalled Wasm");
});
