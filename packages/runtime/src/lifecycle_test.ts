import { Observer } from "@ink/observability/observer.ts";
import { create_test_sink } from "@ink/observability/sink.ts";
import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { parse_game_artifact } from "./artifact.ts";
import { frame_id } from "./frame.ts";
import type { Block, Capability, GameGuest } from "./graph.ts";
import { RuntimeLifecycle } from "./lifecycle.ts";

function observer() {
  return new Observer({
    source: { subsystem: "runtime" },
    sink: create_test_sink(),
    clock: { now_seconds: () => 1 },
  });
}

Deno.test("runtime phases follow graph order and cleanup reverses every acquisition", async () => {
  const phases: string[] = [];
  const artifact = parse_game_artifact({
    guest_id: "game",
    artifact_digest: "artifact-1",
    schema_digest: "schema-1",
    wasm: new Uint8Array([1]),
    capabilities: [{ id: "storage", availability: "required" }],
  });
  const capability: Capability = {
    id: "storage",
    acquire: () => {
      phases.push("acquire storage");
      return {
        value: "storage value",
        release: () => {
          phases.push("release storage");
        },
      };
    },
  };
  const block = (id: string, dependencies: readonly string[]): Block => ({
    id,
    dependencies,
    capabilities: ["storage"],
    acquire: ({ capabilities }) => {
      phases.push(`acquire ${id} with ${capabilities.get("storage")}`);
      return {
        initialize: () => {
          phases.push(`initialize ${id}`);
        },
        start: () => {
          phases.push(`start ${id}`);
        },
        fixed_step: () => {
          phases.push(`fixed ${id}`);
        },
        frame: () => {
          phases.push(`frame ${id}`);
        },
        close: () => {
          phases.push(`close ${id}`);
        },
      };
    },
  });
  const runtime = new RuntimeLifecycle({
    guest: {
      artifact,
      blocks: [block("world", ["input"]), block("input", [])],
    },
    capabilities: [capability],
    observer: observer(),
  });

  await runtime.initialize();
  await runtime.start();
  await runtime.fixed_step({
    frame_id: frame_id(0),
    fixed_step_sequence: 0,
    simulation_time_seconds: 0.02,
    delta_seconds: 0.02,
  });
  await runtime.frame({
    frame_id: frame_id(0),
    fixed_step_sequence: 1,
    elapsed_seconds: 0.02,
    delta_seconds: 0.02,
    interpolation: 0,
  });
  const first_close = runtime.close();
  const second_close = runtime.close();
  assertStrictEquals(first_close, second_close);
  await first_close;

  assertEquals(phases, [
    "acquire storage",
    "acquire input with storage value",
    "initialize input",
    "acquire world with storage value",
    "initialize world",
    "start input",
    "start world",
    "fixed input",
    "fixed world",
    "frame input",
    "frame world",
    "close world",
    "close input",
    "release storage",
  ]);
  assertEquals(runtime.state, "closed");
});

Deno.test("initialization failure identifies its block and cleans acquired resources once", async () => {
  const releases: string[] = [];
  const artifact = parse_game_artifact({
    guest_id: "failing-game",
    artifact_digest: "artifact-2",
    schema_digest: "schema-1",
    wasm: new Uint8Array([1]),
    capabilities: [{ id: "graphics", availability: "required" }],
  });
  const blocks: Block[] = [
    {
      id: "scene",
      dependencies: [],
      capabilities: [],
      acquire: () => ({
        close: () => {
          releases.push("scene");
        },
      }),
    },
    {
      id: "renderer",
      dependencies: ["scene"],
      capabilities: ["graphics"],
      acquire: () => ({
        initialize: () => {
          throw new Error("adapter lost");
        },
        close: () => {
          releases.push("renderer");
        },
      }),
    },
  ];
  const runtime = new RuntimeLifecycle({
    guest: { artifact, blocks },
    capabilities: [{
      id: "graphics",
      acquire: () => ({
        value: {},
        release: () => {
          releases.push("graphics");
        },
      }),
    }],
    observer: observer(),
  });

  await assertRejects(
    () => runtime.initialize(),
    Error,
    'guest "failing-game" artifact "artifact-2" block "renderer" failed during initialize: adapter lost',
  );
  await runtime.close();
  assertEquals(releases, ["renderer", "scene", "graphics"]);
  assertEquals(runtime.state, "closed");
});

Deno.test("optional acquisition failure leaves the capability absent and emits evidence", async () => {
  const sink = create_test_sink();
  const runtime_observer = new Observer({
    source: { subsystem: "runtime" },
    sink,
    clock: { now_seconds: () => 1 },
  });
  const artifact = parse_game_artifact({
    guest_id: "headless-game",
    artifact_digest: "artifact-3",
    schema_digest: "schema-1",
    wasm: new Uint8Array([1]),
    capabilities: [{ id: "graphics", availability: "optional" }],
  });
  let graphics_present = true;
  const runtime = new RuntimeLifecycle({
    guest: {
      artifact,
      blocks: [{
        id: "scene",
        dependencies: [],
        capabilities: ["graphics"],
        acquire: ({ capabilities }) => {
          graphics_present = capabilities.has("graphics");
          return {};
        },
      }],
    },
    capabilities: [{
      id: "graphics",
      acquire: () => {
        throw new Error("no adapter");
      },
    }],
    observer: runtime_observer,
  });

  await runtime.initialize();
  assertEquals(graphics_present, false);
  assertEquals(
    sink.observations().filter((entry) =>
      entry.type === "diagnostic" &&
      entry.operation === "runtime.capability.acquire"
    ).length,
    1,
  );
  await runtime.close();
});

Deno.test("blocks cannot request capabilities absent from the artifact contract", () => {
  const artifact = parse_game_artifact({
    guest_id: "game",
    artifact_digest: "artifact-4",
    schema_digest: "schema-1",
    wasm: new Uint8Array([1]),
    capabilities: [],
  });
  const guest: GameGuest = {
    artifact,
    blocks: [{
      id: "renderer",
      dependencies: [],
      capabilities: ["graphics"],
      acquire: () => ({}),
    }],
  };
  assertThrows(
    () =>
      new RuntimeLifecycle({
        guest,
        capabilities: [],
        observer: observer(),
      }),
    Error,
    'block "renderer" requests undeclared capability "graphics"',
  );
});
