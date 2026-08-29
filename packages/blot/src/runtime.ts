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
import type {
  GameAction,
  GameObservation,
  GameViewport,
  RenderSnapshot,
} from "./protocol.ts";

const minimum_camera_zoom_level = 2;
const initial_camera_zoom_level = 10;
const maximum_camera_zoom_level = 80;

export interface BlotPresentation {
  readonly observation: GameObservation;
  readonly snapshot: RenderSnapshot;
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
  let camera_zoom_level = initial_camera_zoom_level;
  let sequence = 0;

  return {
    artifact: options.artifact,
    blocks: [],
    reset() {
      guest_state = options.wasm_guest.start();
      camera_zoom_level = initial_camera_zoom_level;
      sequence = 0;
    },
    advance(
      step: RuntimeStep<GameAction>,
      context: RuntimeExecutionContext,
    ) {
      let elapsed_applied = false;
      for (const input of step.inputs) {
        const action = parse_game_action(encode_game_action(input));
        const encoded = encode_wasm_action(action);
        const elapsed_us = action.type === "frame" && !elapsed_applied
          ? step.elapsed_us
          : 0;
        guest_state = options.wasm_guest.step(
          guest_state,
          encoded.kind,
          encoded.target,
          encoded.value,
          elapsed_us,
        );
        if (action.type === "frame") elapsed_applied = true;
        if (action.type === "zoom") {
          camera_zoom_level = Math.max(
            minimum_camera_zoom_level,
            Math.min(
              maximum_camera_zoom_level,
              camera_zoom_level + (action.direction === "in" ? 1 : -1),
            ),
          );
        }
      }
      if (
        !elapsed_applied && (step.elapsed_us > 0 || step.inputs.length === 0)
      ) {
        guest_state = options.wasm_guest.step(
          guest_state,
          0,
          0,
          0,
          step.elapsed_us,
        );
      }
      sequence = context.sequence;
    },
    observe(query) {
      const viewport = parse_game_viewport(
        parse_json_value(query, "Blot viewport query"),
      );
      const snapshot = render_with_state(
        options.wasm_guest,
        guest_state,
        camera_zoom_level,
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
      };
    },
    snapshot() {
      return new TextEncoder().encode(JSON.stringify({
        version: 1,
        sequence,
        camera_zoom_level,
        guest_state: {
          scalar: guest_state.scalar.toString(),
          cells: guest_state.cells.map((cell) => cell.toString()),
        },
      }));
    },
    restore(payload) {
      const restored = parse_blot_runtime_state(payload);
      guest_state = restored.guest_state;
      camera_zoom_level = restored.camera_zoom_level;
      sequence = restored.sequence;
    },
    close() {},
  };
}

function encode_game_action(action: GameAction): JsonValue {
  switch (action.type) {
    case "frame":
      return { type: "frame" };
    case "focus":
    case "activate":
      return { type: action.type, target: action.target };
    case "zoom":
      return { type: "zoom", direction: action.direction };
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
    case "frame":
      expect_fields(value, ["type"], "Blot frame action");
      return { type: "frame" };
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
    case "zoom":
      expect_fields(value, ["direction", "type"], "Blot zoom action");
      if (value.direction !== "in" && value.direction !== "out") {
        throw new Error(
          `Blot zoom direction ${
            JSON.stringify(value.direction)
          } is unsupported`,
        );
      }
      return { type: "zoom", direction: value.direction };
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
    case "frame":
      return { kind: 0, target: 0, value: 0 };
    case "focus":
      return { kind: 1, target: action.target, value: 0 };
    case "activate":
      return { kind: 2, target: action.target, value: 0 };
    case "zoom":
      return {
        kind: 3,
        target: 0,
        value: action.direction === "in" ? 1 : -1,
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
  readonly camera_zoom_level: number;
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
    ["camera_zoom_level", "guest_state", "sequence", "version"],
    "Blot runtime state",
  );
  if (parsed_value.version !== 1) {
    throw new Error(
      `Blot runtime state version ${
        JSON.stringify(parsed_value.version)
      } must be 1`,
    );
  }
  const sequence = nonnegative_integer(
    parsed_value.sequence,
    "Blot runtime state sequence",
  );
  const camera_zoom_level = positive_integer(
    parsed_value.camera_zoom_level,
    "Blot runtime camera zoom level",
  );
  if (
    camera_zoom_level < minimum_camera_zoom_level ||
    camera_zoom_level > maximum_camera_zoom_level
  ) {
    throw new Error(
      `Blot runtime camera zoom level ${camera_zoom_level} must be between ${minimum_camera_zoom_level} and ${maximum_camera_zoom_level}`,
    );
  }
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
      camera_zoom_level,
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
  const captured = guest.describe(guest_state, viewport);
  const region_ids = new Set<string>();
  for (const region of captured.regions) {
    if (region_ids.has(region.id)) {
      throw new Error(
        `game emitted duplicate semantic region id ${
          JSON.stringify(region.id)
        }`,
      );
    }
    region_ids.add(region.id);
  }
  const object_ids = new Set([
    ...rendered.nodes.map((node) => node.id),
    ...rendered.objects.map((object) => object.id),
  ]);
  for (const region of captured.regions) {
    if (
      region.placement.type === "scene_object" &&
      !object_ids.has(region.placement.object)
    ) {
      throw new Error(
        `semantic region ${
          JSON.stringify(region.id)
        } attaches to missing scene object ${region.placement.object}`,
      );
    }
  }
  return {
    sequence,
    outcome: captured.status.done ? "won" : "running",
    projection: rendered.projection,
    camera_zoom: rendered.camera_zoom,
    regions: captured.regions,
    status: captured.status,
    actions: [
      ...captured.regions.flatMap((region) => region.actions),
      ...captured.actions,
    ],
  };
}

function render_with_state(
  guest: GameGuest,
  guest_state: GameState,
  camera_zoom_level: number,
  viewport: GameViewport,
): RenderSnapshot {
  const rendered = guest.render(guest_state, viewport);
  if (!Number.isFinite(rendered.camera_zoom) || rendered.camera_zoom <= 0) {
    throw new Error(`game emitted invalid camera zoom ${rendered.camera_zoom}`);
  }
  const camera_zoom = rendered.camera_zoom * camera_zoom_level /
    initial_camera_zoom_level;
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
  return { ...rendered, camera_zoom };
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
