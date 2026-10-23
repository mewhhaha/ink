import { assert, assertEquals, assertThrows } from "@std/assert";
import { compile } from "./support.ts";

const bindings = new URL("./fixtures/pen/", import.meta.url);

Deno.test("Pen baseline records its schema and generator snapshot", async () => {
  const provenance = JSON.parse(
    await Deno.readTextFile(new URL("provenance.json", bindings)),
  );
  assertEquals(provenance.contract, {
    magic: 4670534,
    header_lanes: 146,
    event_lanes: 5,
    draw_lanes: 24,
    inset_lanes: 48,
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
        assertEquals(packet.length, 609);
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
        assertEquals(packet[144], 1);
        assertEquals(packet[145], 1);
        assertEquals(packet.slice(146, 149), [42, 0, 0]);
        assertEquals(packet.slice(149, 165), [
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
        assertEquals(packet.slice(165, 171), [4, 1, 2, 3, 4, 32]);
        assertEquals(packet.slice(171, 177), [1, 0, 1, 0, 1, 0]);
        assertEquals(packet.slice(195, 202), [0, 2, 0.5, 0, 1.25, 20000, 0.25]);
        assertEquals(packet[266], 1); // inset after_sprites
        assertEquals(packet.slice(305, 316), [0, 2, 2, 0, 0, 2, 2, 1, 2, 3, 4]);
        assertEquals(packet.slice(316, 326), [7, 1, 0, 1, 2, 3, 4, 2, 65, 66]);
        assertEquals(packet.slice(326, 341), [
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
        assertEquals(packet.slice(341, 353), [
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
      "frame occlusion respects both scene requests and saved preferences",
      () => {
        assertEquals(fixture.guest.call("occlusion_default", 0), true);
        for (let flags = 0; flags < 4; flags++) {
          const packet = Array.from(
            fixture.guest.call("occlusion_packet", flags) as Float32Array,
          );
          const preferred = Math.floor(flags / 2);
          assertEquals(packet[71], (flags % 2) * preferred);
          assertEquals(packet.slice(146, 160), [
            1,
            0,
            1,
            0,
            0,
            preferred,
            0,
            1,
            0,
            0.5,
            0.75,
            0.25,
            0,
            0,
          ]);
        }
      },
    );
    await t.step(
      "frame resolution caps respect player settings without saving the cap",
      () => {
        assertEquals(fixture.guest.call("render_scale_default", 0), 2);
        for (const preferred of [0.5, 0.75, 1, 1.5, 2]) {
          for (const cap of [-1, 0.5, 0.75, 1, 1.5, 2, 3]) {
            const packet = Array.from(
              fixture.guest.call(
                "render_scale_packet",
                new Float32Array([preferred, cap, 1]),
              ) as Float32Array,
            );
            assertEquals(
              packet[69],
              Math.min(preferred, Math.max(0.5, Math.min(2, cap))),
            );
            assertEquals(packet.slice(146, 160), [
              1,
              0,
              preferred,
              0,
              0,
              0,
              0,
              1,
              0,
              0.5,
              0.75,
              0.25,
              0,
              0,
            ]);
          }
        }
        const unchanged = Array.from(
          fixture.guest.call(
            "render_scale_packet",
            new Float32Array([2, 0.5, 0]),
          ) as Float32Array,
        );
        assertEquals(unchanged[69], 0.5);
        assertEquals(unchanged[11], 0);
        assertEquals(unchanged.length, 146 + 15);
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
        assertEquals(fixture.guest.call("renderer_ready", 0), true);
        assertEquals(fixture.guest.call("session_started", 0), false);
        assertEquals(fixture.guest.call("session_started", 1), true);
        assertThrows(() => fixture.guest.call("session_started", 2));
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
