import { assertEquals, assertThrows } from "@std/assert";
import type { GameGuest } from "./game_guest.ts";
import { create_headless_session } from "./headless_session.ts";
import {
  type JsonlResponse,
  parse_command,
  run_jsonl_session,
} from "./jsonl.ts";

Deno.test("step commands parse into a trusted action", () => {
  assertEquals(
    parse_command(JSON.stringify({
      id: "next",
      command: "step",
      action: { type: "activate", target: 2 },
      delta_us: 20_000,
    })),
    {
      id: "next",
      command: "step",
      action: { type: "activate", target: 2 },
      delta_us: 20_000,
    },
  );
});

Deno.test("frame events accept an explicit delta", () => {
  assertEquals(
    parse_command(JSON.stringify({
      id: "frame",
      command: "step",
      action: { type: "frame" },
      delta_us: 250_000,
    })),
    {
      id: "frame",
      command: "step",
      action: { type: "frame" },
      delta_us: 250_000,
    },
  );
});

Deno.test("zoom commands accept a direction", () => {
  assertEquals(
    parse_command(JSON.stringify({
      id: "zoom-out",
      command: "step",
      action: { type: "zoom", direction: "out" },
    })),
    {
      id: "zoom-out",
      command: "step",
      action: { type: "zoom", direction: "out" },
    },
  );
});

Deno.test("zoom commands reject an unsupported direction", () => {
  assertThrows(
    () =>
      parse_command(JSON.stringify({
        id: "zoom",
        command: "step",
        action: { type: "zoom", direction: "closer" },
      })),
    Error,
    'action.direction "closer" must be "in" or "out"',
  );
});

Deno.test("step commands reject malformed action targets", () => {
  assertThrows(
    () =>
      parse_command(JSON.stringify({
        id: 1,
        command: "step",
        action: { type: "activate", target: "tile-2" },
      })),
    Error,
    'action.target "tile-2" must be a nonnegative safe integer',
  );
});

Deno.test("commands reject fields that are not part of their branch", () => {
  assertThrows(
    () =>
      parse_command(JSON.stringify({
        id: 1,
        command: "describe",
        action: { type: "custom", kind: 3, target: 0, value: 0 },
      })),
    Error,
    'command describe fields are ["action","command","id"]',
  );
});

Deno.test("replays reject steps with a discontinuous sequence", () => {
  assertThrows(
    () =>
      parse_command(JSON.stringify({
        id: 1,
        command: "replay",
        replay: {
          format: "ink-replay",
          version: 1,
          artifact_digest: "artifact",
          initial_save: {
            format: "ink-save",
            version: 1,
            game: "game_development",
            artifact_digest: "artifact",
            schema_digest: "schema",
            state: "0",
            random_state: "0",
            checksum: "checksum",
          },
          steps: [{
            sequence: 2,
            delta_us: 16_667,
            action: { type: "custom", kind: 3, target: 0, value: 0 },
            state_digest: "state",
            observation_digest: "observation",
          }],
        },
      })),
    Error,
    "replay.steps[0].sequence 2 must be 1",
  );
});

Deno.test("JSONL sessions stream responses and close after the close command", async () => {
  const guest: GameGuest = {
    state_schema: "",
    start: () => ({ scalar: 0n, cells: [] }),
    step: (state) => state,
    describe: () => ({
      actions: [],
      regions: [],
      status: { label: "Test", value: "Ready", done: false },
    }),
    render: () => ({
      projection: "orthographic",
      camera_zoom: 1,
      directional_light: {
        type: "directional_light",
        color: [1, 1, 1],
        direction: [0, 0, -1],
        intensity: 1,
      },
      objects: [],
      resources: [],
    }),
  };
  const session = await create_headless_session(guest, {
    game_id: "jsonl-test",
    artifact_digest: "artifact",
    schema_digest: "schema",
  });
  const encoder = new TextEncoder();
  const source = encoder.encode(
    '{"id":"first","command":"describe"}\n' +
      '{"id":2,"command":"unknown"}\n' +
      '{"id":"last","command":"close"}\n' +
      '{"id":"ignored","command":"describe"}\n',
  );
  const input = (async function* () {
    yield source.slice(0, 17);
    yield source.slice(17);
  })();
  const responses: JsonlResponse[] = [];

  await run_jsonl_session(session, input, (response) => {
    responses.push(response);
    return Promise.resolve();
  });

  assertEquals(responses, [
    {
      id: "first",
      ok: true,
      result: {
        sequence: 0,
        outcome: "running",
        projection: "orthographic",
        camera_zoom: 1,
        regions: [],
        status: { label: "Test", value: "Ready", done: false },
        actions: [],
      },
    },
    { id: null, ok: false, error: 'command "unknown" is not supported' },
    { id: "last", ok: true, result: { closed: true } },
  ]);
  assertThrows(
    () => session.describe(),
    Error,
    "headless game session is closed",
  );
});
