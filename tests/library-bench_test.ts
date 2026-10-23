import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  checkWitness,
  runWorkload,
  sourceInventory,
  workloads,
} from "../tools/library-bench.ts";
import { modules } from "../mod.ts";
import { compile } from "./support.ts";

const workerSource = (source: string) =>
  new URL(`data:application/javascript,${encodeURIComponent(source)}`);

Deno.test("every Blot module has a measured workload", () => {
  assertEquals(
    [...new Set(workloads.flatMap((item) => item.modules))].sort(),
    [...modules].sort(),
  );
});

Deno.test("bubble workload checks moving curves and camera plane round trips", async () => {
  const workload = workloads.find((item) => item.entry === "bubbles_workload")!;
  const fixture = await compile(
    new URL("./perf/bubbles.blot", import.meta.url),
  );
  try {
    for (const size of workload.sizes) {
      const witness = fixture.guest.call(workload.entry, size) as Float32Array;
      checkWitness(workload, size, Array.from(witness));
    }
  } finally {
    await fixture.dispose();
  }
});

Deno.test("benchmark inventory includes imported fixture helpers and pinned standard sources", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ink-inventory-" });
  try {
    const entry = `${directory}/main.blot`;
    await Deno.writeTextFile(
      entry,
      'import * as helper from "./dependency-test"\nentry const answer = helper.value\n',
    );
    await Deno.writeTextFile(
      `${directory}/dependency-test.blot`,
      "const value = 42\n",
    );
    const inventory = await sourceInventory([{
      ...workloads[0],
      fixture: entry,
    }]);
    const paths = inventory.map((source) => source.file);
    assertEquals(
      paths.some((path) => path.endsWith("/dependency-test.blot")),
      true,
    );
    assertEquals(
      paths.some((path) => path.endsWith("/std/prelude.blot")),
      true,
    );
    assertEquals(paths.some((path) => path.endsWith("/std/array.blot")), true);
    assertEquals(
      inventory.every((source) => /^[a-f0-9]{64}$/.test(source.sha256)),
      true,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
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

Deno.test("migrated modules retain independently checked numerical witnesses", async () => {
  const fixtures = new Map<string, Awaited<ReturnType<typeof compile>>>();
  try {
    const migrated = new Set([
      "../tests/perf/composition.blot",
      "../tests/ecs.blot",
      "../tests/app-hooks.blot",
      "../tests/clock.blot",
      "../tests/persist.blot",
      "../tests/ui_boundaries.blot",
      "../tests/input.blot",
      "../tests/migration-bench.blot",
      "../tests/migrated_geometry.blot",
    ]);
    for (const workload of workloads) {
      if (!migrated.has(workload.fixture)) continue;
      let fixture = fixtures.get(workload.fixture);
      if (!fixture) {
        fixture = await compile(
          new URL(workload.fixture, new URL("../tools/", import.meta.url)),
        );
        fixtures.set(workload.fixture, fixture);
      }
      for (const size of workload.sizes) {
        const result = fixture.guest.call(workload.entry, size);
        let witness: number[];
        if (typeof result === "number") witness = [result];
        else witness = Array.from(result as Float32Array | Uint32Array);
        checkWitness(workload, size, witness);
      }
    }
  } finally {
    for (const fixture of fixtures.values()) await fixture.dispose();
  }
});

Deno.test("simulation adapter benchmark preserves collider positions and record widths", async () => {
  const workload = workloads.find((item) =>
    item.entry === "simulation_colliders"
  )!;
  const fixture = await compile(
    new URL("./perf/adapters.blot", import.meta.url),
    {
      "pen/": new URL("./fixtures/pen/", import.meta.url),
    },
  );
  try {
    for (const size of workload.sizes) {
      const result = fixture.guest.call(workload.entry, size) as Float32Array;
      checkWitness(workload, size, Array.from(result));
    }
  } finally {
    await fixture.dispose();
  }
});
