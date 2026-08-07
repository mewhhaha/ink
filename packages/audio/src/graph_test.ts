import { assertEquals, assertThrows } from "@std/assert";
import { AudioGraph, compile_graph } from "./graph.ts";
import { bus_id, effect_id } from "./model.ts";

const master = bus_id("master");
const effects = bus_id("effects");

function graph_definition() {
  return {
    master,
    buses: [
      { id: master, gain: 1, effects: [], sends: [] },
      {
        id: effects,
        output: master,
        gain: 0.8,
        effects: [{
          id: effect_id("low-pass"),
          type: "filter" as const,
          filter: "lowpass" as const,
          frequency_hz: 2_000,
          quality: 1,
          gain_db: 0,
        }],
        sends: [],
      },
    ],
  };
}

Deno.test("graph compiles in downstream-first processing order", () => {
  assertEquals(compile_graph(graph_definition()).processing_order, [
    master,
    effects,
  ]);
});

Deno.test("graph rejects missing routes before installation", () => {
  assertThrows(
    () =>
      compile_graph({
        master,
        buses: [{
          id: master,
          gain: 1,
          effects: [],
          sends: [{ bus: bus_id("missing"), gain: 1 }],
        }],
      }),
    Error,
    'send "missing" is missing',
  );
});

Deno.test("graph rejects routing cycles with the route attached", () => {
  assertThrows(
    () =>
      compile_graph({
        master,
        buses: [
          {
            id: master,
            gain: 1,
            effects: [],
            sends: [{ bus: effects, gain: 1 }],
          },
          { id: effects, output: master, gain: 1, effects: [], sends: [] },
        ],
      }),
    Error,
    "routing cycle",
  );
});

Deno.test("graph replacement lists changed native resources", () => {
  const graph = new AudioGraph(graph_definition());
  const replacement = graph.replace({
    ...graph_definition(),
    buses: graph_definition().buses.map((bus) =>
      bus.id === effects ? { ...bus, gain: 0.5 } : bus
    ),
  });
  assertEquals(replacement.previous_revision, 0);
  assertEquals(replacement.snapshot.revision, 1);
  assertEquals(replacement.operations.map((operation) => operation.type), [
    "replace_bus",
  ]);
});

Deno.test("meter snapshots do not expose mutable internal state", () => {
  const graph = new AudioGraph(graph_definition());
  graph.record_level(master, 0.8, 0.4);
  const snapshot = graph.snapshot();
  (snapshot.levels as Map<typeof master, { peak: number; rms: number }>)
    .clear();
  assertEquals(graph.snapshot().levels.get(master), { peak: 0.8, rms: 0.4 });
});

Deno.test("graph snapshots canonicalize and detach authored buses", () => {
  const definition = graph_definition();
  const snapshot = compile_graph(definition);
  definition.buses[1].effects[0].frequency_hz = 10 as never;
  assertEquals(snapshot.buses[0].id, effects);
  assertEquals(snapshot.buses[0].effects[0], {
    id: effect_id("low-pass"),
    type: "filter",
    filter: "lowpass",
    frequency_hz: 2_000,
    quality: 1,
    gain_db: 0,
  });
  assertEquals(Object.isFrozen(snapshot.buses[0].effects[0]), true);
});

Deno.test("graph rejects unsupported effect and filter discriminants", () => {
  assertThrows(
    () =>
      compile_graph({
        master,
        buses: [{
          id: master,
          gain: 1,
          sends: [],
          effects: [{
            id: effect_id("broken"),
            type: "chorus",
          } as never],
        }],
      }),
    Error,
    'type "chorus" is unsupported',
  );
  assertThrows(
    () =>
      compile_graph({
        master,
        buses: [{
          id: master,
          gain: 1,
          sends: [],
          effects: [{
            id: effect_id("broken"),
            type: "filter",
            filter: "warped",
            frequency_hz: 1,
            quality: 1,
            gain_db: 0,
          } as never],
        }],
      }),
    Error,
    'filter "warped" is unsupported',
  );
  assertThrows(
    () =>
      compile_graph({
        master,
        buses: [{
          id: master,
          gain: 1,
          sends: [],
          effects: [{
            id: effect_id("broken"),
            type: "convolution",
            impulse_clip: 42,
            wet: 1,
          } as never],
        }],
      }),
    Error,
    "impulse clip 42 must be a non-empty string",
  );
});
