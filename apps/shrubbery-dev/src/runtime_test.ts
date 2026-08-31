import { assertEquals } from "@std/assert";
import { Observer } from "@ink/observability/observer.ts";
import { create_redacting_sink } from "@ink/observability/redaction.ts";
import { create_ring_buffer_sink } from "@ink/observability/sink.ts";
import { microseconds } from "@ink/runtime/identity.ts";
import { create_shrubbery_session, shrubbery_observation } from "./runtime.ts";

Deno.test("Blot shrubbery actions change the scene published by the runtime", async () => {
  const observation_log = create_ring_buffer_sink(100);
  const session = await create_shrubbery_session(
    await Deno.readFile("generated/shrubbery.wasm"),
    await Deno.readTextFile("generated/shrubbery.wasm.json"),
    new Observer({
      source: { subsystem: "shrubbery-headless-test" },
      sink: create_redacting_sink(observation_log),
      clock: { now_seconds: () => performance.now() / 1_000 },
    }),
  );
  try {
    const initial = shrubbery_observation(
      await session.observe({ width: 1280, height: 720 }),
    );
    const flowers_action = initial.actions.find(({ id }) => id === "flowers")
      ?.action;
    if (flowers_action === undefined) {
      throw new Error("Blot shrubbery observation omitted flowers action");
    }
    await session.advance({
      elapsed_us: microseconds(0),
      inputs: [flowers_action],
    });
    const flowers = shrubbery_observation(
      await session.observe({ width: 1280, height: 720 }),
    );

    assertEquals(initial.selected_name, "mixed shrubbery");
    assertEquals(flowers.selected_name, "flower patch");
    assertEquals(
      initial.snapshot.objects.length > flowers.snapshot.objects.length,
      true,
    );
    assertEquals(initial.actions.length, 6);
    assertEquals(initial.snapshot.camera, {
      type: "perspective",
      position: [0, 9, 16],
      target: [0, 2.1, 0],
      clear_color: [0.016, 0.025, 0.045],
      vertical_fov_radians: 0.85,
    });
    assertEquals(initial.snapshot.environment, {
      ambient_light: [0.08, 0.11, 0.16],
      fog_color: [0.03, 0.055, 0.075],
      fog_density: 0.013,
      exposure_ev100: -0.25,
      bloom_intensity: 0.08,
    });
    assertEquals(
      observation_log.observations().some((observation) =>
        observation.type === "event" &&
        observation.name === "runtime.session.initialized"
      ),
      true,
    );
  } finally {
    await session.close();
  }
});
