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
      } else {
        for (const entry of ["render_columns", "render_meshes"]) {
          assertEquals(
            fixture.guest.call(entry, 0),
            new Float32Array([0, 0, 0]),
          );
        }
        const old = Array.from({ length: 35 }, (_, i) => i).filter((i) =>
          i % 4 !== 0
        );
        const next = [...old.filter((i) => i > 3), 35];
        const x = (i: number) => i === 35 ? 999 : i * 10 + 2;
        assertEquals(
          fixture.guest.call("render_snapshots", null),
          new Float32Array([
            ...old.flatMap((i) => [i, i * 10, i]),
            ...next.flatMap((i) => [i, x(i), i]),
            100,
            0,
            101,
            0,
            ...next.flatMap((i) => [i, x(i)]),
            102,
            0,
          ]),
        );
      }
    } finally {
      await fixture.dispose();
    }
  }
});
