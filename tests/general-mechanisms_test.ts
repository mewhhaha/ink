import { assertEquals, assertThrows } from "@std/assert";
import { compile } from "./support.ts";

Deno.test("sensor dashboard composes the six mechanisms without a game or host", async () => {
  const fixture = await compile(
    new URL("../examples/mechanisms.blot", import.meta.url),
  );
  try {
    assertEquals(
      Array.from(fixture.guest.call("dashboard", 0) as Float32Array),
      [5, 1, 300, 48, 328, 48, 1, 2, 1],
    );
  } finally {
    await fixture.dispose();
  }
});

Deno.test("general field, history, layout, console and localization mechanisms", async (t) => {
  const url = new URL("./general-mechanisms.blot", import.meta.url);
  const fixture = await compile(url);
  try {
    const source = await Deno.readTextFile(url);
    for (const match of source.matchAll(/entry const (test_\w+)/g)) {
      await t.step(match[1], () => {
        const result = fixture.guest.call(match[1], null) as Float32Array;
        assertEquals(result[1], 0, Array.from(result).join());
      });
    }
    await t.step(
      "ring order and retained snapshots match an independent array model",
      () => {
        for (let steps = 0; steps < 200; steps++) {
          const capacity = steps % 17;
          const values: number[] = [];
          let old: number[] = [];
          for (let i = 0; i < steps; i++) {
            values.push(i);
            if (values.length > capacity) values.shift();
            if (i === Math.floor(steps / 2)) old = [...values];
          }
          assertEquals(
            Array.from(
              fixture.guest.call("history_values", steps) as Float32Array,
            ),
            [values.length, old.length, ...values, ...old],
          );
        }
      },
    );
    for (
      const name of [
        "trap_history_backwards",
        "trap_field_dimensions",
        "trap_locale_request",
      ]
    ) {
      assertThrows(() => fixture.guest.call(name, 1));
    }
  } finally {
    await fixture.dispose();
  }
});
