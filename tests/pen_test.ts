import { assert, assertEquals, assertThrows } from "@std/assert";
import { compile } from "./support.ts";

const bindings = new URL("./fixtures/pen/", import.meta.url);

Deno.test("Pen baseline records its schema and generator snapshot", async () => {
  const provenance = JSON.parse(
    await Deno.readTextFile(new URL("provenance.json", bindings)),
  );
  assertEquals(provenance.contract, {
    magic: 4670534,
    header_lanes: 138,
    event_lanes: 5,
    draw_lanes: 24,
    inset_lanes: 47,
    ui_head_lanes: 24,
  });
  assert(/^[a-f0-9]{64}$/.test(provenance.schema_sha256));
  assert(/^[a-f0-9]{64}$/.test(provenance.generator_sha256));
  for (const [name, expected] of Object.entries(provenance.files)) {
    const bytes = await Deno.readFile(new URL(name, bindings));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const actual = Array.from(
      new Uint8Array(digest),
      (value) => value.toString(16).padStart(2, "0"),
    ).join("");
    assertEquals(actual, expected, name);
    const source = new TextDecoder().decode(bytes);
    for (const imported of source.matchAll(/^import .* from "([^"]+)"/gm)) {
      assert(
        ["std/array", "./lanes", "./protocol", "./types"].includes(imported[1]),
        imported[1],
      );
    }
  }
});

Deno.test("Pen adapters preserve packet records, events and commands", async (t) => {
  const start = performance.now();
  const fixture = await compile(new URL("./pen.blot", import.meta.url), {
    "pen/": bindings,
  });
  try {
    const call = (name: string) =>
      Array.from(fixture.guest.call(name, 0) as Float32Array);
    await t.step(
      "frame records retain lane order and trimmed draw tails",
      () => {
        const packet = call("frame_packet");
        assertEquals(packet.length, 600);
        assertEquals(packet.slice(0, 12), [
          4670534,
          3,
          1,
          1,
          1,
          6,
          1,
          1,
          1,
          1,
          1,
          14,
        ]);
        assertEquals(packet.slice(130, 138), [1, 11, 0, 0, 1, 10, 5, 1]);
        assertEquals(packet.slice(138, 141), [42, 0, 0]);
        assertEquals(packet.slice(141, 157), [
          1,
          0,
          0,
          0,
          0,
          1,
          0,
          0,
          0,
          0,
          1,
          0,
          0,
          0,
          0,
          1,
        ]);
        assertEquals(packet.slice(157, 163), [4, 1, 2, 3, 4, 32]);
        assertEquals(packet.slice(163, 169), [1, 0, 1, 0, 1, 0]);
        assertEquals(packet.slice(187, 194), [0, 2, 0.5, 0, 1.25, 20000, 0.25]);
        assertEquals(packet.slice(296, 307), [0, 2, 2, 0, 0, 2, 2, 1, 2, 3, 4]);
        assertEquals(packet.slice(307, 317), [7, 1, 0, 1, 2, 3, 4, 2, 65, 66]);
        assertEquals(packet.slice(317, 332), [
          0.5,
          20000,
          1,
          0.25,
          20000,
          0,
          0.75,
          20000,
          Math.fround(0.12),
          0.75,
          20000,
          0,
          0.75,
          20000,
          0,
        ]);
        assertEquals(packet.slice(332, 344), [
          9,
          0,
          1,
          0.75,
          0.5,
          1,
          12000,
          0.25,
          1,
          0,
          0.5,
          0.25,
        ]);
        assertEquals(
          packet.slice(-256),
          Array.from({ length: 256 }, (_, index) => [5, 6, 7, 8][index % 4]),
        );
      },
    );
    await t.step(
      "UI text is bounded and parents refer to earlier positions",
      () => {
        const packet = call("ui_nodes_packet");
        assertEquals(packet.length, 1101);
        assertEquals(packet.slice(0, 2), [11, 0]);
        assertEquals(packet.slice(21, 24), [1024, 1024, 0]);
        assertEquals(packet.slice(24, 1048), new Array(1024).fill(65));
        assertEquals(packet.slice(1048, 1050), [12, 1]);
        assertEquals(packet.slice(1075, 1077), [13, 0]);
      },
    );
    await t.step(
      "input events and all host commands retain their meanings",
      () => {
        assertEquals(call("events_packet"), [65, 7, 1, 2, 3]);
        for (let operation = 0; operation <= 7; operation++) {
          assertEquals(
            fixture.guest.call(
              "commands_packet",
              new Float32Array([1, operation]),
            ),
            operation,
          );
        }
        assertThrows(() =>
          fixture.guest.call("commands_packet", new Float32Array([1, 8]))
        );
      },
    );
    await t.step("settings pages and platform codec remain explicit", () => {
      assertEquals(
        [0, 1, 2].map((page) => fixture.guest.call("settings_back", page)),
        [9, 3, 1],
      );
      assertEquals(call("platform_packet"), [0, 255, 0, 0, 0, 0]);
    });
    await t.step(
      "service adapter carries wire fields without retry bookkeeping",
      () => {
        assertEquals(call("service_packet"), [
          16777215,
          5,
          255,
          1,
          2,
          3,
          4,
          2,
          -0.25,
          0.5,
        ]);
      },
    );
    console.log(
      `Pen adapter compile and witnesses: ${
        (performance.now() - start).toFixed(1)
      } ms`,
    );
  } finally {
    await fixture.dispose();
  }
});
