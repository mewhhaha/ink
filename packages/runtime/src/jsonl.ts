import type { JsonValue } from "./digest.ts";
import {
  type Microseconds,
  microseconds,
  type RuntimeCodec,
  type RuntimeSession,
} from "./session.ts";

const maximum_command_bytes = 1024 * 1024;
const maximum_inputs_per_advance = 10_000;

export interface RuntimeJsonlCodec<Input, Query, Observation>
  extends RuntimeCodec<Input> {
  decode_query(value: JsonValue): Query;
  encode_observation(observation: Observation): JsonValue;
}

export type JsonlCommand<Input, Query> =
  | {
    readonly id: string | number;
    readonly command: "observe";
    readonly query: Query;
  }
  | { readonly id: string | number; readonly command: "reset" }
  | {
    readonly id: string | number;
    readonly command: "advance";
    readonly inputs: readonly Input[];
    readonly elapsed_us: Microseconds;
  }
  | { readonly id: string | number; readonly command: "save" }
  | {
    readonly id: string | number;
    readonly command: "load";
    readonly snapshot: string;
  }
  | { readonly id: string | number; readonly command: "finish_replay" }
  | {
    readonly id: string | number;
    readonly command: "replay";
    readonly replay: unknown;
  }
  | { readonly id: string | number; readonly command: "trace" }
  | { readonly id: string | number; readonly command: "close" };

export type JsonlResponse =
  | {
    readonly id: string | number;
    readonly ok: true;
    readonly result: unknown;
  }
  | {
    readonly id: string | number | null;
    readonly ok: false;
    readonly error: string;
  };

export interface JsonlResponseWriter {
  (response: JsonlResponse): void | Promise<void>;
}

export function parse_jsonl_command<Input, Query, Observation>(
  line: string,
  codec: RuntimeJsonlCodec<Input, Query, Observation>,
): JsonlCommand<Input, Query> {
  if (new TextEncoder().encode(line).length > maximum_command_bytes) {
    throw new Error(`JSONL command exceeds ${maximum_command_bytes} bytes`);
  }
  let parsed_value: unknown;
  try {
    parsed_value = JSON.parse(line);
  } catch (cause) {
    throw new Error("JSONL command is not valid JSON", { cause });
  }
  if (!is_record(parsed_value)) {
    throw new Error("JSONL command must be an object");
  }
  const id = parse_id(parsed_value.id);
  if (typeof parsed_value.command !== "string") {
    throw new Error(
      `command ${JSON.stringify(parsed_value.command)} must be a string`,
    );
  }
  switch (parsed_value.command) {
    case "reset":
    case "save":
    case "finish_replay":
    case "trace":
    case "close":
      expect_fields(
        parsed_value,
        ["command", "id"],
        `command ${parsed_value.command}`,
      );
      return { id, command: parsed_value.command };
    case "observe":
      expect_fields(
        parsed_value,
        ["command", "id", "query"],
        "command observe",
      );
      return {
        id,
        command: "observe",
        query: codec.decode_query(
          parse_json_value(parsed_value.query, "command observe query"),
        ),
      };
    case "advance":
      expect_fields(
        parsed_value,
        ["command", "elapsed_us", "id", "inputs"],
        "command advance",
      );
      if (
        !Array.isArray(parsed_value.inputs) ||
        parsed_value.inputs.length > maximum_inputs_per_advance
      ) {
        throw new Error(
          `command advance inputs must be an array of at most ${maximum_inputs_per_advance} entries`,
        );
      }
      return {
        id,
        command: "advance",
        elapsed_us: microseconds(
          typeof parsed_value.elapsed_us === "number"
            ? parsed_value.elapsed_us
            : Number.NaN,
        ),
        inputs: parsed_value.inputs.map((input, index) =>
          codec.decode_input(
            parse_json_value(input, `command advance input ${index}`),
          )
        ),
      };
    case "load":
      expect_fields(
        parsed_value,
        ["command", "id", "snapshot"],
        "command load",
      );
      if (typeof parsed_value.snapshot !== "string") {
        throw new Error("command load snapshot must be a string");
      }
      return { id, command: "load", snapshot: parsed_value.snapshot };
    case "replay":
      expect_fields(
        parsed_value,
        ["command", "id", "replay"],
        "command replay",
      );
      return { id, command: "replay", replay: parsed_value.replay };
    default:
      throw new Error(
        `command ${JSON.stringify(parsed_value.command)} is not supported`,
      );
  }
}

export async function dispatch_jsonl_command<Input, Query, Observation>(
  session: RuntimeSession<Input, Query, Observation>,
  codec: RuntimeJsonlCodec<Input, Query, Observation>,
  command: JsonlCommand<Input, Query>,
): Promise<unknown> {
  switch (command.command) {
    case "observe":
      return codec.encode_observation(await session.observe(command.query));
    case "reset":
      return await session.reset();
    case "advance":
      return await session.advance({
        elapsed_us: command.elapsed_us,
        inputs: command.inputs,
      });
    case "save":
      return await session.save();
    case "load":
      return await session.load(command.snapshot);
    case "finish_replay":
      return await session.finish_replay();
    case "replay":
      return await session.replay(command.replay);
    case "trace":
      return session.trace();
    case "close":
      await session.close();
      return { closed: true };
  }
}

export async function run_jsonl_session<Input, Query, Observation>(
  session: RuntimeSession<Input, Query, Observation>,
  codec: RuntimeJsonlCodec<Input, Query, Observation>,
  input: AsyncIterable<Uint8Array>,
  write_response: JsonlResponseWriter,
): Promise<void> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffered = "";
  let closed = false;
  for await (const chunk of input) {
    try {
      buffered += decoder.decode(chunk, { stream: true });
    } catch {
      await write_response({
        id: null,
        ok: false,
        error: "JSONL input is not valid UTF-8",
      });
      await session.close();
      return;
    }
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    if (new TextEncoder().encode(buffered).length > maximum_command_bytes) {
      await write_response({
        id: null,
        ok: false,
        error: `JSONL command exceeds ${maximum_command_bytes} bytes`,
      });
      buffered = "";
    }
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      closed = await respond_to_line(session, codec, line, write_response);
      if (closed) break;
    }
    if (closed) break;
  }
  try {
    buffered += decoder.decode();
  } catch {
    await write_response({
      id: null,
      ok: false,
      error: "JSONL input ends with invalid UTF-8",
    });
    await session.close();
    return;
  }
  if (!closed && buffered.trim().length > 0) {
    closed = await respond_to_line(session, codec, buffered, write_response);
  }
  if (!closed) await session.close();
}

async function respond_to_line<Input, Query, Observation>(
  session: RuntimeSession<Input, Query, Observation>,
  codec: RuntimeJsonlCodec<Input, Query, Observation>,
  line: string,
  write_response: JsonlResponseWriter,
): Promise<boolean> {
  let command: JsonlCommand<Input, Query>;
  try {
    command = parse_jsonl_command(line, codec);
  } catch (error) {
    await write_response({ id: null, ok: false, error: error_reason(error) });
    return false;
  }
  try {
    const result = await dispatch_jsonl_command(session, codec, command);
    await write_response({ id: command.id, ok: true, result });
    return command.command === "close";
  } catch (error) {
    await write_response({
      id: command.id,
      ok: false,
      error: error_reason(error),
    });
    return false;
  }
}

function parse_id(value: unknown): string | number {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(
    `command id ${JSON.stringify(value)} must be a string or finite number`,
  );
}

function parse_json_value(value: unknown, path: string, depth = 0): JsonValue {
  if (depth > 64) throw new Error(`${path} exceeds 64 nested JSON levels`);
  if (
    value === null || typeof value === "string" || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      parse_json_value(entry, `${path}[${index}]`, depth + 1)
    );
  }
  if (is_record(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        parse_json_value(entry, `${path}.${key}`, depth + 1),
      ]),
    );
  }
  throw new Error(`${path} contains non-JSON value ${String(value)}`);
}

function expect_fields(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  if (actual.join("\n") !== [...expected].sort().join("\n")) {
    throw new Error(`${label} fields are ${JSON.stringify(actual)}`);
  }
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function error_reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
