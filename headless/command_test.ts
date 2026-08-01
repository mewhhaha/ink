import { assertEquals, assertThrows } from "@std/assert";
import { parse_command } from "./command.ts";

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

Deno.test("step commands reject malformed action targets", () => {
  assertThrows(
    () =>
      parse_command(JSON.stringify({
        id: 1,
        command: "step",
        action: { type: "activate", target: "beacon-2" },
      })),
    Error,
    'action.target "beacon-2" must be a nonnegative safe integer',
  );
});

Deno.test("commands reject fields that are not part of their branch", () => {
  assertThrows(
    () =>
      parse_command(JSON.stringify({
        id: 1,
        command: "observe",
        action: { type: "toggle_projection" },
      })),
    Error,
    'command observe fields are ["action","command","id"]',
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
            game: "scene_explorer",
            artifact_digest: "artifact",
            schema_digest: "schema",
            state: "0",
            random_state: "0",
            checksum: "checksum",
          },
          steps: [{
            sequence: 2,
            delta_us: 16_667,
            action: { type: "toggle_projection" },
            state_digest: "state",
            observation_digest: "observation",
          }],
        },
      })),
    Error,
    "replay.steps[0].sequence 2 must be 1",
  );
});
