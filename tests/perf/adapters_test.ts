import { assertEquals } from "@std/assert";
import { compile } from "../support.ts";
import { checkWitness, workloads } from "../../tools/library-bench.ts";

Deno.test("scaled adapter and presentation workloads preserve independent witnesses", async () => {
  for (const name of ["adapters", "presentation"]) {
    const fixture = await compile(new URL(`./${name}.blot`, import.meta.url), {
      "pen/": new URL("../fixtures/pen/", import.meta.url),
    });
    try {
      for (
        const workload of workloads.filter((w) =>
          w.fixture === `../tests/perf/${name}.blot`
        )
      ) {
        for (const size of workload.sizes) {
          const value = fixture.guest.call(workload.entry, size);
          checkWitness(
            workload,
            size,
            Array.from(value as Float32Array | Uint32Array),
          );
        }
      }
      if (name === "adapters") {
        const pairs = [
          [0, 0],
          [9, 0],
          [9, 9],
          [10, 9],
          [8, 10],
          [7, 8],
          [11, 12],
          [12, 11],
          [0xffffffff, 0],
          [13, 0xffffffff],
          [8, 0],
          [14, 8],
        ];
        assertEquals(
          Array.from(
            fixture.guest.call(
              "parent_indices",
              new Uint32Array(pairs.flat()),
            ) as Uint32Array,
          ),
          [0, 0, 2, 2, 4, 5, 0, 7, 0, 9, 0, 5],
        );
      }
    } finally {
      await fixture.dispose();
    }
  }
});
