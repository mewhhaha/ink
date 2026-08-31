import type { BlotPresentation } from "@ink/blot/runtime.ts";
import type {
  Renderer,
  RenderFrameResult,
  RenderPickResult,
  RenderScene,
} from "@ink/rendering/renderer.ts";
import type { RuntimeRevision } from "@ink/runtime/session.ts";
import { platformer_player_animation } from "./animation.ts";

export interface PlatformerSceneEvidence {
  readonly player_position: readonly [number, number, number];
  readonly exit_position: readonly [number, number, number];
  readonly exit_visible: boolean;
}

export interface PlatformerSemanticEvidence {
  readonly outcome: "running" | "won";
  readonly status: {
    readonly done: boolean;
    readonly label: string;
    readonly value: string;
  };
  readonly action_ids: readonly string[];
}

export interface PlatformerPresentationEvidence {
  readonly semantic: PlatformerSemanticEvidence;
  readonly scene: PlatformerSceneEvidence;
}

export interface PlatformerAnimationEvidence {
  readonly sample_time: number;
  readonly rendered_position: readonly [number, number, number];
  readonly rendered_rotation_z_radians: number;
  readonly rendered_scale: readonly [number, number, number];
}

export type PlatformerRevisionEvidence =
  | { readonly type: "initial" }
  | {
    readonly type: "advanced";
    readonly sequence: number;
    readonly snapshot_checksum: string;
  };

export interface PlatformerRendererEvidence {
  readonly adapter_description: string;
  readonly status:
    | "ready"
    | "path_tracing_unavailable"
    | "device_error"
    | "device_lost";
  readonly validation_error_count: number;
  readonly frame_type: "raster" | "path_traced";
  readonly center_pick: string;
}

export interface PlatformerBrowserEvidence
  extends PlatformerPresentationEvidence {
  readonly version: 4;
  readonly animation: PlatformerAnimationEvidence;
  readonly runtime: PlatformerRevisionEvidence;
  readonly presentation_source: string;
  readonly renderer: PlatformerRendererEvidence;
  readonly retained_observations: number;
  readonly encoded_input_frames: readonly string[];
}

export function platformer_presentation_evidence(
  presentation: BlotPresentation,
): PlatformerPresentationEvidence {
  const player = required_object(presentation, 10, "player");
  const exit = required_object(presentation, 11, "exit");
  return Object.freeze({
    semantic: Object.freeze({
      outcome: presentation.observation.outcome,
      status: Object.freeze({ ...presentation.observation.status }),
      action_ids: Object.freeze(
        presentation.observation.actions.map(({ id }) => id),
      ),
    }),
    scene: Object.freeze({
      player_position: player.position,
      exit_position: exit.position,
      exit_visible: exit.visible,
    }),
  });
}

export function platformer_browser_evidence(
  presentation: BlotPresentation,
  revision: RuntimeRevision | undefined,
  retained_observations: number,
  encoded_input_frames: readonly string[],
  scene: RenderScene,
  renderer: Renderer,
  frame: RenderFrameResult,
  pick: RenderPickResult,
): PlatformerBrowserEvidence {
  const visible = platformer_presentation_evidence(presentation);
  const player_animation = platformer_player_animation(presentation.snapshot);
  const rendered_player = scene.hierarchy.nodes.find(({ id }) =>
    id.index === 10
  );
  if (rendered_player === undefined) {
    throw new Error("platformer render scene omitted player node 10");
  }
  const rendered_position: [number, number, number] = [
    rendered_player.local_transform.position.x,
    rendered_player.local_transform.position.y,
    rendered_player.local_transform.position.z,
  ];
  const rendered_scale: [number, number, number] = [
    rendered_player.local_transform.scale.x,
    rendered_player.local_transform.scale.y,
    rendered_player.local_transform.scale.z,
  ];
  const runtime: PlatformerRevisionEvidence = revision === undefined
    ? { type: "initial" }
    : {
      type: "advanced",
      sequence: revision.sequence,
      snapshot_checksum: revision.snapshot_checksum,
    };
  return Object.freeze({
    version: 4,
    runtime: Object.freeze(runtime),
    ...visible,
    animation: Object.freeze({
      sample_time: player_animation.sample_time,
      rendered_position: Object.freeze(rendered_position),
      rendered_rotation_z_radians: 2 * Math.atan2(
        rendered_player.local_transform.rotation.z,
        rendered_player.local_transform.rotation.w,
      ),
      rendered_scale: Object.freeze(rendered_scale),
    }),
    presentation_source: serialize_platformer_presentation(presentation),
    renderer: Object.freeze({
      adapter_description: renderer.adapter_description,
      status: renderer.status.type,
      validation_error_count: renderer.validation_error_count,
      frame_type: frame.type,
      center_pick: pick.type === "hit" ? pick.object_id : "miss",
    }),
    retained_observations,
    encoded_input_frames: Object.freeze([...encoded_input_frames]),
  });
}

export function serialize_platformer_presentation(
  presentation: BlotPresentation,
): string {
  return JSON.stringify(presentation);
}

export function serialize_platformer_browser_evidence(
  evidence: PlatformerBrowserEvidence,
): string {
  return JSON.stringify(evidence);
}

export function parse_platformer_browser_evidence(
  source: string,
): PlatformerBrowserEvidence {
  const value: unknown = JSON.parse(source);
  const root = record(value, "platformer browser evidence");
  if (root.version !== 4) {
    throw new Error(
      `platformer browser evidence version ${
        JSON.stringify(root.version)
      } is unsupported`,
    );
  }
  const runtime_record = record(
    root.runtime,
    "platformer browser runtime evidence",
  );
  const runtime = parse_revision(runtime_record);
  const renderer_record = record(
    root.renderer,
    "platformer browser renderer evidence",
  );
  const semantic_record = record(
    root.semantic,
    "platformer browser semantic evidence",
  );
  const outcome = semantic_record.outcome;
  if (outcome !== "running" && outcome !== "won") {
    throw new Error(
      `platformer browser outcome ${JSON.stringify(outcome)} is unsupported`,
    );
  }
  const status_record = record(
    semantic_record.status,
    "platformer browser status evidence",
  );
  const action_ids = string_array(
    semantic_record.action_ids,
    "platformer browser action ids",
  );
  const scene_record = record(root.scene, "platformer browser scene evidence");
  const animation_record = record(
    root.animation,
    "platformer browser animation evidence",
  );
  return Object.freeze({
    version: 4,
    runtime,
    presentation_source: text(
      root.presentation_source,
      "platformer browser presentation source",
    ),
    renderer: Object.freeze({
      adapter_description: text(
        renderer_record.adapter_description,
        "platformer renderer adapter",
      ),
      status: one_of(
        renderer_record.status,
        ["ready", "path_tracing_unavailable", "device_error", "device_lost"],
        "platformer renderer status",
      ),
      validation_error_count: nonnegative_integer(
        renderer_record.validation_error_count,
        "platformer renderer validation errors",
      ),
      frame_type: one_of(
        renderer_record.frame_type,
        ["raster", "path_traced"],
        "platformer renderer frame type",
      ),
      center_pick: text(
        renderer_record.center_pick,
        "platformer renderer center pick",
      ),
    }),
    semantic: Object.freeze({
      outcome,
      status: Object.freeze({
        done: boolean_value(status_record.done, "platformer status done"),
        label: text(status_record.label, "platformer status label"),
        value: text(status_record.value, "platformer status value"),
      }),
      action_ids,
    }),
    scene: Object.freeze({
      player_position: position(
        scene_record.player_position,
        "platformer player position",
      ),
      exit_position: position(
        scene_record.exit_position,
        "platformer exit position",
      ),
      exit_visible: boolean_value(
        scene_record.exit_visible,
        "platformer exit visibility",
      ),
    }),
    animation: Object.freeze({
      sample_time: finite_number(
        animation_record.sample_time,
        "platformer animation sample time",
      ),
      rendered_position: position(
        animation_record.rendered_position,
        "platformer rendered player position",
      ),
      rendered_rotation_z_radians: finite_number(
        animation_record.rendered_rotation_z_radians,
        "platformer rendered player rotation",
      ),
      rendered_scale: position(
        animation_record.rendered_scale,
        "platformer rendered player scale",
      ),
    }),
    retained_observations: nonnegative_integer(
      root.retained_observations,
      "platformer retained observations",
    ),
    encoded_input_frames: string_array(
      root.encoded_input_frames,
      "platformer encoded input frames",
    ),
  });
}

function required_object(
  presentation: BlotPresentation,
  object_id: number,
  label: string,
) {
  const object = presentation.snapshot.objects.find(({ id }) =>
    id === object_id
  );
  if (object === undefined) {
    throw new Error(
      `platformer presentation omitted ${label} object ${object_id}`,
    );
  }
  return object;
}

function parse_revision(
  value: Readonly<Record<string, unknown>>,
): PlatformerRevisionEvidence {
  if (value.type === "initial") return Object.freeze({ type: "initial" });
  if (value.type !== "advanced") {
    throw new Error(
      `platformer browser runtime type ${
        JSON.stringify(value.type)
      } is unsupported`,
    );
  }
  const snapshot_checksum = text(
    value.snapshot_checksum,
    "platformer snapshot checksum",
  );
  if (!/^[0-9a-f]{64}$/u.test(snapshot_checksum)) {
    throw new Error(
      `platformer snapshot checksum ${
        JSON.stringify(snapshot_checksum)
      } must contain 64 lowercase hexadecimal characters`,
    );
  }
  return Object.freeze({
    type: "advanced",
    sequence: nonnegative_integer(value.sequence, "platformer sequence"),
    snapshot_checksum,
  });
}

function position(
  value: unknown,
  label: string,
): readonly [number, number, number] {
  if (
    !Array.isArray(value) || value.length !== 3 ||
    value.some((coordinate) =>
      typeof coordinate !== "number" || !Number.isFinite(coordinate)
    )
  ) {
    throw new Error(`${label} ${JSON.stringify(value)} must contain 3 numbers`);
  }
  return Object.freeze([value[0], value[1], value[2]]);
}

function string_array(value: unknown, label: string): readonly string[] {
  if (
    !Array.isArray(value) || value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`${label} ${JSON.stringify(value)} must contain text`);
  }
  return Object.freeze([...value]);
}

function one_of<const Value extends string>(
  value: unknown,
  supported: readonly Value[],
  label: string,
): Value {
  if (typeof value === "string") {
    const matched = supported.find((candidate) => candidate === value);
    if (matched !== undefined) return matched;
  }
  throw new Error(`${label} ${JSON.stringify(value)} is unsupported`);
}

function record(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} ${JSON.stringify(value)} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} ${JSON.stringify(value)} must be text`);
  }
  return value;
}

function boolean_value(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} ${JSON.stringify(value)} must be boolean`);
  }
  return value;
}

function finite_number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} ${JSON.stringify(value)} must be finite`);
  }
  return value;
}

function nonnegative_integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(
      `${label} ${JSON.stringify(value)} must be a nonnegative integer`,
    );
  }
  return value as number;
}
