import {
  type Effect,
  type Fails,
  from_either,
  Left,
  Program,
  Right,
  run,
  run_except,
} from "@mewhhaha/typeclasses";
import type {
  GameAction,
  GameReplay,
  GameSave,
  ReplayStep,
} from "../runtime/protocol.ts";

export type Command =
  | { readonly id: string | number; readonly command: "observe" }
  | { readonly id: string | number; readonly command: "reset" }
  | {
    readonly id: string | number;
    readonly command: "step";
    readonly action: GameAction;
    readonly delta_us?: number;
  }
  | { readonly id: string | number; readonly command: "save" }
  | {
    readonly id: string | number;
    readonly command: "load";
    readonly save: string;
  }
  | { readonly id: string | number; readonly command: "finish_replay" }
  | { readonly id: string | number; readonly command: "trace" }
  | {
    readonly id: string | number;
    readonly command: "replay";
    readonly replay: GameReplay;
  }
  | { readonly id: string | number; readonly command: "close" };

type CommandParseFailure = readonly ["command.parse", string];
type CommandParser<result> = Effect<Fails<CommandParseFailure>, result>;

const Parse = Program.scope<Fails<CommandParseFailure>>();

export function parse_command(line: string): Command {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (cause) {
    throw new Error("JSONL command is not valid JSON", { cause });
  }

  const outcome = run(run_except(parse_command_value(parsed)));
  const [branch, value] = outcome.value();
  if (branch === "Left") throw new Error(value[1]);
  return value;
}

function parse_command_value(value: unknown): CommandParser<Command> {
  return Parse(function* () {
    const command = yield* expect_record(value, "JSONL command");
    const id = yield* parse_command_id(command.id);
    const name = yield* expect_string(command.command, "command");

    switch (name) {
      case "observe":
      case "reset":
      case "save":
      case "finish_replay":
      case "trace":
      case "close":
        yield* expect_fields(command, ["command", "id"], `command ${name}`);
        return { id, command: name };
      case "step": {
        const fields = Object.hasOwn(command, "delta_us")
          ? ["action", "command", "delta_us", "id"]
          : ["action", "command", "id"];
        yield* expect_fields(command, fields, "command step");
        const action = yield* parse_game_action(command.action, "action");
        if (!Object.hasOwn(command, "delta_us")) {
          return { id, command: "step", action };
        }
        const delta_us = yield* expect_nonnegative_integer(
          command.delta_us,
          "delta_us",
        );
        return { id, command: "step", action, delta_us };
      }
      case "load":
        yield* expect_fields(
          command,
          ["command", "id", "save"],
          "command load",
        );
        return {
          id,
          command: "load",
          save: yield* expect_string(command.save, "save"),
        };
      case "replay":
        yield* expect_fields(
          command,
          ["command", "id", "replay"],
          "command replay",
        );
        return {
          id,
          command: "replay",
          replay: yield* parse_replay(command.replay),
        };
      default:
        return yield* reject(
          `command ${JSON.stringify(name)} is not supported`,
        );
    }
  });
}

function parse_game_action(
  value: unknown,
  path: string,
): CommandParser<GameAction> {
  return Parse(function* () {
    const action = yield* expect_record(value, path);
    const type = yield* expect_string(action.type, `${path}.type`);
    switch (type) {
      case "focus":
      case "activate":
        yield* expect_fields(action, ["target", "type"], path);
        return {
          type,
          target: yield* expect_nonnegative_integer(
            action.target,
            `${path}.target`,
          ),
        };
      case "toggle_projection":
        yield* expect_fields(action, ["type"], path);
        return { type };
      default:
        return yield* reject(
          `${path}.type ${JSON.stringify(type)} is not supported`,
        );
    }
  });
}

function parse_replay(value: unknown): CommandParser<GameReplay> {
  return Parse(function* () {
    const replay = yield* expect_record(value, "replay");
    yield* expect_fields(
      replay,
      ["artifact_digest", "format", "initial_save", "steps", "version"],
      "replay",
    );
    yield* expect_literal(replay.format, "ink-replay", "replay.format");
    yield* expect_literal(replay.version, 1, "replay.version");
    const artifact_digest = yield* expect_string(
      replay.artifact_digest,
      "replay.artifact_digest",
    );
    const initial_save = yield* parse_save(replay.initial_save);
    const raw_steps = yield* expect_array(replay.steps, "replay.steps");
    const steps: ReplayStep[] = [];
    for (const [index, raw_step] of raw_steps.entries()) {
      const step = yield* parse_replay_step(raw_step, index);
      if (step.sequence !== index + 1) {
        return yield* reject(
          `replay.steps[${index}].sequence ${step.sequence} must be ${
            index + 1
          }`,
        );
      }
      steps.push(step);
    }
    return {
      format: "ink-replay",
      version: 1,
      artifact_digest,
      initial_save,
      steps,
    };
  });
}

function parse_replay_step(
  value: unknown,
  index: number,
): CommandParser<ReplayStep> {
  const path = `replay.steps[${index}]`;
  return Parse(function* () {
    const step = yield* expect_record(value, path);
    yield* expect_fields(
      step,
      [
        "action",
        "delta_us",
        "observation_digest",
        "sequence",
        "state_digest",
      ],
      path,
    );
    return {
      sequence: yield* expect_nonnegative_integer(
        step.sequence,
        `${path}.sequence`,
      ),
      delta_us: yield* expect_nonnegative_integer(
        step.delta_us,
        `${path}.delta_us`,
      ),
      action: yield* parse_game_action(step.action, `${path}.action`),
      state_digest: yield* expect_string(
        step.state_digest,
        `${path}.state_digest`,
      ),
      observation_digest: yield* expect_string(
        step.observation_digest,
        `${path}.observation_digest`,
      ),
    };
  });
}

function parse_save(value: unknown): CommandParser<GameSave> {
  return Parse(function* () {
    const save = yield* expect_record(value, "replay.initial_save");
    yield* expect_fields(
      save,
      [
        "artifact_digest",
        "checksum",
        "format",
        "game",
        "random_state",
        "schema_digest",
        "state",
        "version",
      ],
      "replay.initial_save",
    );
    yield* expect_literal(
      save.format,
      "ink-save",
      "replay.initial_save.format",
    );
    yield* expect_literal(save.version, 1, "replay.initial_save.version");
    yield* expect_literal(
      save.game,
      "scene_explorer",
      "replay.initial_save.game",
    );
    const state = yield* expect_decimal(
      save.state,
      "replay.initial_save.state",
    );
    const random_state = yield* expect_decimal(
      save.random_state,
      "replay.initial_save.random_state",
    );
    return {
      format: "ink-save",
      version: 1,
      game: "scene_explorer",
      artifact_digest: yield* expect_string(
        save.artifact_digest,
        "replay.initial_save.artifact_digest",
      ),
      schema_digest: yield* expect_string(
        save.schema_digest,
        "replay.initial_save.schema_digest",
      ),
      state,
      random_state,
      checksum: yield* expect_string(
        save.checksum,
        "replay.initial_save.checksum",
      ),
    };
  });
}

function parse_command_id(
  value: unknown,
): CommandParser<string | number> {
  if (typeof value === "string") return accept(value);
  if (typeof value === "number" && Number.isFinite(value)) return accept(value);
  return reject(
    `command id ${JSON.stringify(value)} must be a string or finite number`,
  );
}

function expect_record(
  value: unknown,
  path: string,
): CommandParser<Record<string, unknown>> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return accept(value as Record<string, unknown>);
  }
  return reject(`${path} ${JSON.stringify(value)} must be an object`);
}

function expect_array(
  value: unknown,
  path: string,
): CommandParser<readonly unknown[]> {
  return Array.isArray(value)
    ? accept(value)
    : reject(`${path} ${JSON.stringify(value)} must be an array`);
}

function expect_string(value: unknown, path: string): CommandParser<string> {
  return typeof value === "string"
    ? accept(value)
    : reject(`${path} ${JSON.stringify(value)} must be a string`);
}

function expect_decimal(value: unknown, path: string): CommandParser<string> {
  return typeof value === "string" && /^-?(0|[1-9][0-9]*)$/.test(value)
    ? accept(value)
    : reject(`${path} ${JSON.stringify(value)} must be a decimal string`);
}

function expect_nonnegative_integer(
  value: unknown,
  path: string,
): CommandParser<number> {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? accept(value)
    : reject(
      `${path} ${JSON.stringify(value)} must be a nonnegative safe integer`,
    );
}

function expect_literal<const literal extends string | number>(
  value: unknown,
  expected: literal,
  path: string,
): CommandParser<literal> {
  return value === expected ? accept(expected) : reject(
    `${path} ${JSON.stringify(value)} must be ${JSON.stringify(expected)}`,
  );
}

function expect_fields(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): CommandParser<void> {
  const actual = Object.keys(value).sort();
  const sorted_expected = [...expected].sort();
  return actual.join("\n") === sorted_expected.join("\n")
    ? accept(undefined)
    : reject(`${path} fields are ${JSON.stringify(actual)}`);
}

function accept<result>(value: result): CommandParser<result> {
  return from_either(Right<CommandParseFailure, result>(value));
}

function reject<result = never>(message: string): CommandParser<result> {
  const failure: CommandParseFailure = ["command.parse", message];
  return from_either(Left<CommandParseFailure, result>(failure));
}
