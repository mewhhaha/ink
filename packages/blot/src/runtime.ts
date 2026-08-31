import type { JsonValue } from "@ink/runtime/digest.ts";
import type { GameArtifact } from "@ink/runtime/artifact.ts";
import type { RuntimeJsonlCodec } from "@ink/runtime/jsonl.ts";
import type {
  RuntimeExecutionContext,
  RuntimeGuest,
  RuntimeSession,
  RuntimeStep,
} from "@ink/runtime/session.ts";
import type { GameGuest, GameState } from "./game_guest.ts";
import { blot_abi_registry } from "./abi.ts";
import type {
  BlotHostEffect,
  GameAction,
  GameObservation,
  GameViewport,
  RenderSnapshot,
} from "./protocol.ts";
import { flatten_semantic_tree } from "@ink/ui/semantic.ts";

export interface BlotPresentation {
  readonly observation: GameObservation;
  readonly snapshot: RenderSnapshot;
  readonly effects: readonly BlotHostEffect[];
}

export type BlotRuntimeGuest = RuntimeGuest<
  GameAction,
  GameViewport,
  BlotPresentation
>;

export type BlotRuntimeSession = RuntimeSession<
  GameAction,
  GameViewport,
  BlotPresentation
>;

export interface BlotRuntimeGuestOptions {
  readonly artifact: GameArtifact;
  readonly wasm_guest: GameGuest;
}

export const blot_runtime_codec: RuntimeJsonlCodec<
  GameAction,
  GameViewport,
  BlotPresentation
> = {
  encode_input: encode_game_action,
  decode_input: parse_game_action,
  decode_query: parse_game_viewport,
  encode_observation: (presentation) =>
    parse_json_value(presentation, "Blot presentation"),
};

export function create_blot_runtime_guest(
  options: BlotRuntimeGuestOptions,
): BlotRuntimeGuest {
  let guest_state = options.wasm_guest.start();
  let latest_effects: readonly BlotHostEffect[] = [];
  let sequence = 0;

  return {
    artifact: options.artifact,
    reset() {
      guest_state = options.wasm_guest.start();
      latest_effects = [];
      sequence = 0;
    },
    advance(
      step: RuntimeStep<GameAction>,
      context: RuntimeExecutionContext,
    ) {
      const effects: BlotHostEffect[] = [];
      for (const input of step.inputs) {
        const action = parse_game_action(encode_game_action(input));
        const encoded = encode_wasm_action(action);
        const result = options.wasm_guest.step(
          guest_state,
          encoded.kind,
          encoded.target,
          encoded.value,
          0,
        );
        guest_state = result.state;
        effects.push(...result.effects);
      }
      if (step.elapsed_us > 0 || step.inputs.length === 0) {
        const result = options.wasm_guest.step(
          guest_state,
          blot_abi_registry.protocol.events.elapsed,
          0,
          0,
          step.elapsed_us,
        );
        guest_state = result.state;
        effects.push(...result.effects);
      }
      latest_effects = Object.freeze(effects);
      sequence = context.sequence;
    },
    observe(query) {
      const viewport = parse_game_viewport(
        parse_json_value(query, "Blot viewport query"),
      );
      const snapshot = render_with_state(
        options.wasm_guest,
        guest_state,
        viewport,
      );
      return {
        observation: describe_with_snapshot(
          options.wasm_guest,
          guest_state,
          sequence,
          viewport,
          snapshot,
        ),
        snapshot,
        effects: latest_effects,
      };
    },
    snapshot() {
      return new TextEncoder().encode(JSON.stringify({
        version: 2,
        sequence,
        guest_state: {
          scalar: guest_state.scalar.toString(),
          cells: guest_state.cells.map((cell) => cell.toString()),
        },
      }));
    },
    restore(payload) {
      const restored = parse_blot_runtime_state(payload);
      guest_state = restored.guest_state;
      latest_effects = [];
      sequence = restored.sequence;
    },
    close() {},
  };
}

function encode_game_action(action: GameAction): JsonValue {
  switch (action.type) {
    case "focus":
    case "activate":
      return { type: action.type, target: action.target };
    case "custom":
      return {
        type: "custom",
        kind: action.kind,
        target: action.target,
        value: action.value,
      };
  }
}

function parse_game_action(value: JsonValue): GameAction {
  if (!is_record(value) || typeof value.type !== "string") {
    throw new Error("Blot action must be an object with a string type");
  }
  switch (value.type) {
    case "focus":
    case "activate":
      expect_fields(value, ["target", "type"], `Blot ${value.type} action`);
      return {
        type: value.type,
        target: nonnegative_integer(
          value.target,
          `Blot ${value.type} action target`,
        ),
      };
    case "custom":
      expect_fields(
        value,
        ["kind", "target", "type", "value"],
        "Blot custom action",
      );
      return {
        type: "custom",
        kind: nonnegative_integer(value.kind, "Blot custom action kind"),
        target: nonnegative_integer(value.target, "Blot custom action target"),
        value: nonnegative_integer(value.value, "Blot custom action value"),
      };
    default:
      throw new Error(
        `Blot action type ${JSON.stringify(value.type)} is unsupported`,
      );
  }
}

function encode_wasm_action(
  action: GameAction,
): { readonly kind: number; readonly target: number; readonly value: number } {
  switch (action.type) {
    case "focus":
      return {
        kind: blot_abi_registry.protocol.events.focus,
        target: action.target,
        value: 0,
      };
    case "activate":
      return {
        kind: blot_abi_registry.protocol.events.activate,
        target: action.target,
        value: 0,
      };
    case "custom":
      return {
        kind: action.kind,
        target: action.target,
        value: action.value,
      };
  }
}

function parse_game_viewport(value: JsonValue): GameViewport {
  if (!is_record(value)) throw new Error("Blot viewport must be an object");
  expect_fields(value, ["height", "width"], "Blot viewport");
  const width = positive_integer(value.width, "Blot viewport width");
  const height = positive_integer(value.height, "Blot viewport height");
  return Object.freeze({ width, height });
}

function parse_blot_runtime_state(payload: Uint8Array): {
  readonly guest_state: GameState;
  readonly sequence: number;
} {
  let parsed_value: unknown;
  try {
    parsed_value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(payload),
    );
  } catch (cause) {
    throw new Error("Blot runtime state is not valid UTF-8 JSON", { cause });
  }
  if (!is_record(parsed_value)) {
    throw new Error("Blot runtime state must be an object");
  }
  expect_fields(
    parsed_value,
    ["guest_state", "sequence", "version"],
    "Blot runtime state",
  );
  if (parsed_value.version !== 2) {
    throw new Error(
      `Blot runtime state version ${
        JSON.stringify(parsed_value.version)
      } must be 2`,
    );
  }
  const sequence = nonnegative_integer(
    parsed_value.sequence,
    "Blot runtime state sequence",
  );
  if (!is_record(parsed_value.guest_state)) {
    throw new Error("Blot runtime guest state must be an object");
  }
  expect_fields(
    parsed_value.guest_state,
    ["cells", "scalar"],
    "Blot runtime guest state",
  );
  if (
    typeof parsed_value.guest_state.scalar !== "string" ||
    !Array.isArray(parsed_value.guest_state.cells) ||
    parsed_value.guest_state.cells.some((cell) => typeof cell !== "string")
  ) {
    throw new Error(
      "Blot runtime guest state scalar and cells must be strings",
    );
  }
  try {
    return {
      guest_state: {
        scalar: BigInt(parsed_value.guest_state.scalar),
        cells: parsed_value.guest_state.cells.map((cell) => BigInt(cell)),
      },
      sequence,
    };
  } catch (cause) {
    throw new Error("Blot runtime guest state contains an invalid integer", {
      cause,
    });
  }
}

function describe_with_snapshot(
  guest: GameGuest,
  guest_state: GameState,
  sequence: number,
  viewport: GameViewport,
  rendered: RenderSnapshot,
): GameObservation {
  const captured = guest.describe(guest_state, viewport, sequence);
  const object_ids = new Set([
    ...rendered.nodes.map((node) => node.id),
    ...rendered.objects.map((object) => object.id),
  ]);
  for (const node of flatten_semantic_tree(captured.ui.root)) {
    if (
      node.placement?.type === "scene" &&
      !object_ids.has(node.placement.node.index)
    ) {
      throw new Error(
        `UI node ${
          JSON.stringify(node.id)
        } attaches to missing scene object ${node.placement.node.index}`,
      );
    }
  }
  return {
    sequence,
    outcome: captured.status.done ? "won" : "running",
    ui: captured.ui,
    status: captured.status,
    actions: captured.actions,
  };
}

function render_with_state(
  guest: GameGuest,
  guest_state: GameState,
  viewport: GameViewport,
): RenderSnapshot {
  const rendered = guest.render(guest_state, viewport);
  const object_ids = new Set<number>();
  for (const node of rendered.nodes) {
    if (object_ids.has(node.id)) {
      throw new Error(`game emitted duplicate scene node id ${node.id}`);
    }
    object_ids.add(node.id);
  }
  for (const object of rendered.objects) {
    if (object_ids.has(object.id)) {
      throw new Error(`game emitted duplicate scene object id ${object.id}`);
    }
    object_ids.add(object.id);
  }
  const resource_ids = new Set<string>();
  for (const resource of rendered.resources) {
    const identity = `${resource.type}:${resource.id}`;
    if (resource_ids.has(identity)) {
      throw new Error(
        `game emitted duplicate ${resource.type} resource id ${resource.id}`,
      );
    }
    resource_ids.add(identity);
  }
  return rendered;
}

function nonnegative_integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `${label} ${JSON.stringify(value)} must be a nonnegative safe integer`,
    );
  }
  return value;
}

function positive_integer(value: unknown, label: string): number {
  const parsed = nonnegative_integer(value, label);
  if (parsed === 0) throw new Error(`${label} must be positive`);
  return parsed;
}

function expect_fields(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  if (actual.join("\n") !== [...expected].sort().join("\n")) {
    throw new Error(`${label} fields are ${JSON.stringify(actual)}`);
  }
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

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
