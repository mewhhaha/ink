import { Observer } from "@ink/observability/observer.ts";
import { create_test_sink } from "@ink/observability/sink.ts";
import { assertEquals, assertThrows } from "@std/assert";
import { parse_game_artifact } from "./artifact.ts";
import {
  type JsonlResponse,
  parse_jsonl_command,
  run_jsonl_session,
} from "./jsonl.ts";
import type { RuntimeCodec, RuntimeGuest } from "./session.ts";
import { create_runtime_session } from "./session.ts";

const codec: RuntimeCodec<number, number> = {
  encode_input: (value) => value,
  decode_input: (value) => {
    if (typeof value !== "number") throw new Error("input must be a number");
    return value;
  },
  encode_observation: (value) => value,
};

Deno.test("JSONL command parsing rejects branch fields and delegates input parsing", () => {
  assertEquals(
    parse_jsonl_command(
      '{"id":"step","command":"step","input":3,"delta_seconds":0.5}',
      codec,
    ),
    {
      id: "step",
      command: "step",
      input: 3,
      delta_seconds: 0.5,
    },
  );
  assertThrows(
    () =>
      parse_jsonl_command(
        '{"id":1,"command":"describe","input":3}',
        codec,
      ),
    Error,
    'command describe fields are ["command","id","input"]',
  );
});

Deno.test("JSONL host streams results and closes at the close command", async () => {
  let state = 0;
  let close_count = 0;
  const artifact = parse_game_artifact({
    guest_id: "jsonl",
    artifact_digest: "artifact-1",
    schema_digest: "schema-1",
    wasm: new Uint8Array([1]),
    capabilities: [],
  });
  const guest: RuntimeGuest<number, number> = {
    artifact,
    reset: () => state = 0,
    step: (input) => state += input,
    describe: () => state,
    snapshot: () => new Uint8Array([state]),
    restore: (payload) => {
      state = payload[0];
    },
    close: () => {
      close_count += 1;
    },
  };
  const session = await create_runtime_session({
    guest,
    codec,
    observer: new Observer({
      source: { subsystem: "runtime" },
      sink: create_test_sink(),
      clock: { now_seconds: () => 1 },
    }),
  });
  const source = new TextEncoder().encode(
    '{"id":1,"command":"describe"}\n' +
      '{"id":2,"command":"step","input":4,"delta_seconds":0.1}\n' +
      '{"id":3,"command":"unknown"}\n' +
      '{"id":4,"command":"close"}\n' +
      '{"id":5,"command":"describe"}\n',
  );
  const input = (async function* () {
    yield source.slice(0, 23);
    yield source.slice(23);
  })();
  const responses: JsonlResponse[] = [];
  await run_jsonl_session(session, codec, input, (response) => {
    responses.push(response);
  });
  assertEquals(responses, [
    { id: 1, ok: true, result: 0 },
    { id: 2, ok: true, result: 4 },
    { id: null, ok: false, error: 'command "unknown" is not supported' },
    { id: 4, ok: true, result: { closed: true } },
  ]);
  assertEquals(close_count, 1);
});
