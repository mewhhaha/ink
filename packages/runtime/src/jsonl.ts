import type { JsonValue } from "./digest.ts";
import type { RuntimeCodec, RuntimeSession } from "./session.ts";

const maximum_command_bytes = 1024 * 1024;

export type JsonlCommand<input> =
  | { readonly id: string | number; readonly command: "describe" }
  | { readonly id: string | number; readonly command: "reset" }
  | {
    readonly id: string | number;
    readonly command: "step";
    readonly input: input;
    readonly delta_seconds: number;
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

export function parse_jsonl_command<input, observation>(
  line: string,
  codec: RuntimeCodec<input, observation>,
): JsonlCommand<input> {
  if (new TextEncoder().encode(line).length > maximum_command_bytes) {
    throw new Error(`JSONL command exceeds ${maximum_command_bytes} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (cause) {
    throw new Error("JSONL command is not valid JSON", { cause });
  }
  if (!is_record(parsed)) throw new Error("JSONL command must be an object");
  const id = parse_id(parsed.id);
  if (typeof parsed.command !== "string") {
    throw new Error(
      `command ${JSON.stringify(parsed.command)} must be a string`,
    );
  }
  switch (parsed.command) {
    case "describe":
    case "reset":
    case "save":
    case "finish_replay":
    case "trace":
    case "close":
      expect_fields(parsed, ["command", "id"], `command ${parsed.command}`);
      return { id, command: parsed.command };
    case "step":
      expect_fields(
        parsed,
        ["command", "delta_seconds", "id", "input"],
        "command step",
      );
      if (
        typeof parsed.delta_seconds !== "number" ||
        !Number.isFinite(parsed.delta_seconds) || parsed.delta_seconds < 0
      ) {
        throw new Error(
          `command step delta_seconds ${
            JSON.stringify(parsed.delta_seconds)
          } must be finite nonnegative seconds`,
        );
      }
      return {
        id,
        command: "step",
        input: codec.decode_input(parsed.input as JsonValue),
        delta_seconds: parsed.delta_seconds,
      };
    case "load":
      expect_fields(parsed, ["command", "id", "snapshot"], "command load");
      if (typeof parsed.snapshot !== "string") {
        throw new Error("command load snapshot must be a string");
      }
      return { id, command: "load", snapshot: parsed.snapshot };
    case "replay":
      expect_fields(parsed, ["command", "id", "replay"], "command replay");
      return { id, command: "replay", replay: parsed.replay };
    default:
      throw new Error(
        `command ${JSON.stringify(parsed.command)} is not supported`,
      );
  }
}

export async function dispatch_jsonl_command<input, observation>(
  session: RuntimeSession<input, observation>,
  command: JsonlCommand<input>,
): Promise<unknown> {
  switch (command.command) {
    case "describe":
      return await session.describe();
    case "reset":
      return await session.reset();
    case "step":
      return await session.step(command.input, command.delta_seconds);
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

export async function run_jsonl_session<input, observation>(
  session: RuntimeSession<input, observation>,
  codec: RuntimeCodec<input, observation>,
  input: AsyncIterable<Uint8Array>,
  write_response: JsonlResponseWriter,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffered = "";
  let closed = false;
  for await (const chunk of input) {
    buffered += decoder.decode(chunk, { stream: true });
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
  buffered += decoder.decode();
  if (!closed && buffered.trim().length > 0) {
    closed = await respond_to_line(session, codec, buffered, write_response);
  }
  if (!closed) await session.close();
}

async function respond_to_line<input, observation>(
  session: RuntimeSession<input, observation>,
  codec: RuntimeCodec<input, observation>,
  line: string,
  write_response: JsonlResponseWriter,
): Promise<boolean> {
  let command: JsonlCommand<input>;
  try {
    command = parse_jsonl_command(line, codec);
  } catch (error) {
    await write_response({ id: null, ok: false, error: error_reason(error) });
    return false;
  }
  try {
    const result = await dispatch_jsonl_command(session, command);
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
