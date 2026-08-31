import type { AssetId } from "@ink/assets/identity.ts";
import type { UiEvent } from "@ink/ui/controller.ts";
import type { UiActionReference, UiId, UiSnapshot } from "@ink/ui/semantic.ts";

export type GameAction =
  | { readonly type: "focus"; readonly target: number }
  | { readonly type: "activate"; readonly target: number }
  | {
    readonly type: "custom";
    readonly kind: number;
    readonly target: number;
    readonly value: number;
  };

export type GameActionTrigger =
  | { readonly type: "focus"; readonly target: UiId }
  | { readonly type: "activate"; readonly target: UiId }
  | { readonly type: "command" };

export interface ActionDescription extends UiActionReference {
  readonly trigger: GameActionTrigger;
  readonly action: GameAction;
}

export interface GameStatus {
  readonly label: string;
  readonly value: string;
  readonly done: boolean;
}

export interface GameObservation {
  readonly sequence: number;
  readonly outcome: "running" | "won";
  readonly ui: UiSnapshot;
  readonly status: GameStatus;
  readonly actions: readonly ActionDescription[];
}

export type BlotHostEffect = {
  readonly type: "play_audio";
  readonly id: string;
  readonly cue: AssetId<"audio">;
};

export interface SceneNodeCommand {
  readonly type: "scene_node";
  readonly id: number;
  readonly parent: number | null;
  readonly rotation_radians: readonly [number, number, number];
  readonly position: readonly [number, number, number];
  readonly scale: readonly [number, number, number];
  readonly visible: boolean;
}

export interface SceneObjectCommand {
  readonly type: "scene_object";
  readonly id: number;
  readonly mesh: number;
  readonly parent: number | null;
  readonly color: readonly [number, number, number];
  readonly emissive: number;
  readonly texture: number | null;
  readonly texture_offset: readonly [number, number];
  readonly secondary_texture: number | null;
  readonly texture_scale: readonly [number, number];
  readonly blend_edges: number;
  readonly variation_seed: number;
  readonly surface_mode: SurfaceMode;
  readonly path_connections: number;
  readonly rotation_radians: readonly [number, number, number];
  readonly position: readonly [number, number, number];
  readonly scale: readonly [number, number, number];
  readonly visible: boolean;
}

export type SurfaceMode = 0 | 1 | 2 | 3 | 4;

export interface DirectionalLightCommand {
  readonly type: "directional_light";
  readonly color: readonly [number, number, number];
  readonly direction: readonly [number, number, number];
  readonly intensity: number;
}

export type RenderCameraCommand =
  | {
    readonly type: "perspective";
    readonly position: readonly [number, number, number];
    readonly target: readonly [number, number, number];
    readonly clear_color: readonly [number, number, number];
    readonly vertical_fov_radians: number;
  }
  | {
    readonly type: "orthographic";
    readonly position: readonly [number, number, number];
    readonly target: readonly [number, number, number];
    readonly clear_color: readonly [number, number, number];
    readonly vertical_size: number;
  };

export interface RenderEnvironmentCommand {
  readonly ambient_light: readonly [number, number, number];
  readonly fog_color: readonly [number, number, number];
  readonly fog_density: number;
  readonly exposure_ev100: number;
  readonly bloom_intensity: number;
}

export type SceneResource =
  | {
    readonly type: "mesh";
    readonly id: number;
    readonly asset: AssetId<"mesh">;
  }
  | {
    readonly type: "texture";
    readonly id: number;
    readonly asset: AssetId<"texture">;
  };

export interface RenderSnapshot {
  readonly camera: RenderCameraCommand;
  readonly directional_light: DirectionalLightCommand;
  readonly environment: RenderEnvironmentCommand;
  readonly nodes: readonly SceneNodeCommand[];
  readonly objects: readonly SceneObjectCommand[];
  readonly resources: readonly SceneResource[];
}

export interface GameViewport {
  readonly width: number;
  readonly height: number;
}

export function game_action_from_ui_event(
  observation: GameObservation,
  event: UiEvent,
): GameAction | undefined {
  if (event.type === "focus_changed") {
    if (event.target === null) return undefined;
    return observation.actions.find((description) =>
      description.trigger.type === "focus" &&
      description.trigger.target === event.target
    )?.action;
  }
  if (event.type === "activated") {
    return observation.actions.find((description) =>
      description.trigger.type === "activate" &&
      description.trigger.target === event.target
    )?.action;
  }
  return undefined;
}
