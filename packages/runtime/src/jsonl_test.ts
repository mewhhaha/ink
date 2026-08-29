import { Observer } from "@ink/observability/observer.ts";
import { create_test_sink } from "@ink/observability/sink.ts";
import { assertEquals, assertThrows } from "@std/assert";
import { parse_game_artifact } from "./artifact.ts";
import {
  type JsonlResponse,
  parse_jsonl_command,
  run_jsonl_session,
  type RuntimeJsonlCodec,
} from "./jsonl.ts";
import {
  create_runtime_session,
  microseconds,
  type RuntimeGuest,
} from "./session.ts";

const codec: RuntimeJsonlCodec<number, "value", number> = {
  encode_input: (value) => value,
  decode_input: (value) => {
    if (typeof value !== "number") throw new Error("input must be a number");
    return value;
  },
  decode_query: (value) => {
    if (value !== "value") throw new Error("query must be value");
    return value;
  },
  encode_observation: (value) => value,
};

Deno.test("JSONL parsing accepts batched advance and rejects branch fields", () => {
  assertEquals(
    parse_jsonl_command(
      '{"id":"advance","command":"advance","inputs":[3,4],"elapsed_us":500000}',
      codec,
    ),
    {
      id: "advance",
      command: "advance",
      inputs: [3, 4],
      elapsed_us: microseconds(500_000),
    },
  );
  assertThrows(
    () =>
      parse_jsonl_command(
        '{"id":1,"command":"observe","query":"value","input":3}',
        codec,
      ),
    Error,
    'command observe fields are ["command","id","input","query"]',
  );
});

Deno.test("JSONL host streams observations and closes at the close command", async () => {
  let state = 0;
  let close_count = 0;
  const artifact = parse_game_artifact({
    guest_id: "jsonl",
    artifact_digest: "artifact-1",
    schema_digest: "schema-1",
    wasm: new Uint8Array([1]),
    capabilities: [],
  });
  const guest: RuntimeGuest<number, "value", number> = {
    artifact,
    blocks: [],
    reset: () => {
      state = 0;
    },
    advance: (step) => {
      state += step.inputs.reduce((sum, input) => sum + input, 0);
    },
    observe: () => state,
    snapshot: () => new Uint8Array([state]),
    restore: (payload) => {
      state = payload[0] ?? 0;
    },
    close: () => {
      close_count += 1;
    },
  };
  const session = await create_runtime_session({
    guest,
    codec,
    observer: runtime_observer(),
  });
  const source = new TextEncoder().encode(
    '{"id":1,"command":"observe","query":"value"}\n' +
      '{"id":2,"command":"advance","inputs":[1,3],"elapsed_us":100000}\n' +
      '{"id":3,"command":"observe","query":"value"}\n' +
      '{"id":4,"command":"unknown"}\n' +
      '{"id":5,"command":"close"}\n' +
      '{"id":6,"command":"observe","query":"value"}\n',
  );
  const input = (async function* () {
    yield source.slice(0, 23);
    yield source.slice(23);
  })();
  const responses: JsonlResponse[] = [];
  await run_jsonl_session(session, codec, input, (response) => {
    responses.push(response);
  });
  assertEquals(responses[0], { id: 1, ok: true, result: 0 });
  if (responses[1]?.ok !== true) {
    throw new Error("advance response did not succeed");
  }
  if (typeof responses[1].result !== "object" || responses[1].result === null) {
    throw new Error("advance response revision must be an object");
  }
  assertEquals(Reflect.get(responses[1].result, "sequence"), 1);
  assertEquals(responses.slice(2), [
    { id: 3, ok: true, result: 4 },
    { id: null, ok: false, error: 'command "unknown" is not supported' },
    { id: 5, ok: true, result: { closed: true } },
  ]);
  assertEquals(close_count, 1);
});

Deno.test("JSONL host rejects invalid UTF-8 and closes the session", async () => {
  let close_count = 0;
  const artifact = parse_game_artifact({
    guest_id: "jsonl-invalid-utf8",
    artifact_digest: "artifact-1",
    schema_digest: "schema-1",
    wasm: new Uint8Array([1]),
    capabilities: [],
  });
  const session = await create_runtime_session({
    guest: {
      artifact,
      blocks: [],
      reset: () => {},
      advance: () => {},
      observe: () => 0,
      snapshot: () => new Uint8Array(),
      restore: () => {},
      close: () => {
        close_count += 1;
      },
    },
    codec,
    observer: runtime_observer(),
  });
  const responses: JsonlResponse[] = [];
  const input = (async function* () {
    yield new Uint8Array([0xff]);
  })();

  await run_jsonl_session(session, codec, input, (response) => {
    responses.push(response);
  });
  assertEquals(responses, [{
    id: null,
    ok: false,
    error: "JSONL input is not valid UTF-8",
  }]);
  assertEquals(close_count, 1);
});

function runtime_observer(): Observer {
  return new Observer({
    source: { subsystem: "runtime" },
    sink: create_test_sink(),
    clock: { now_seconds: () => 1 },
  });
}
