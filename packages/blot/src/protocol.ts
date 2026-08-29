export type Projection = "perspective" | "orthographic";

export type GameAction =
  | { readonly type: "frame" }
  | { readonly type: "focus"; readonly target: number }
  | { readonly type: "activate"; readonly target: number }
  | { readonly type: "zoom"; readonly direction: "in" | "out" }
  | {
    readonly type: "custom";
    readonly kind: number;
    readonly target: number;
    readonly value: number;
  };

export interface ActionDescription {
  readonly id: string;
  readonly label: string;
  readonly action: GameAction;
}

interface SemanticRegionBase {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly element_size: {
    readonly width: number;
    readonly height: number;
  };
  readonly placement: SemanticPlacement;
  readonly style: {
    readonly background_color: string;
    readonly border_color: string;
    readonly border_radius: number;
    readonly border_width: number;
    readonly color: string;
    readonly font_size: number;
    readonly font_weight: number;
  };
  readonly order: number;
  readonly actions: readonly ActionDescription[];
}

export type SemanticPlacement =
  | {
    readonly type: "scene_object";
    readonly object: number;
    readonly offset: readonly [number, number, number];
    readonly size: readonly [number, number];
  }
  | {
    readonly type: "viewport";
    readonly anchor:
      | "top_left"
      | "top_right"
      | "bottom_left"
      | "bottom_right"
      | "center";
    readonly inset: readonly [number, number];
  };

export interface ButtonSemanticRegion extends SemanticRegionBase {
  readonly role: "button";
  readonly target: number;
  readonly pressed: boolean;
  readonly selected: boolean;
}

export interface TextSemanticRegion extends SemanticRegionBase {
  readonly role: "text";
}

export interface ProgressSemanticRegion extends SemanticRegionBase {
  readonly role: "progress";
  readonly maximum: number;
  readonly value: number;
}

export type SemanticRegion =
  | ButtonSemanticRegion
  | TextSemanticRegion
  | ProgressSemanticRegion;

export interface GameStatus {
  readonly label: string;
  readonly value: string;
  readonly done: boolean;
}

export interface GameObservation {
  readonly sequence: number;
  readonly outcome: "running" | "won";
  readonly projection: Projection;
  readonly camera_zoom: number;
  readonly regions: readonly SemanticRegion[];
  readonly status: GameStatus;
  readonly actions: readonly ActionDescription[];
}

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
  readonly projection: Projection;
  readonly camera_zoom: number;
  readonly directional_light: DirectionalLightCommand;
  readonly nodes: readonly SceneNodeCommand[];
  readonly objects: readonly SceneObjectCommand[];
  readonly resources: readonly SceneResource[];
}

export interface GameViewport {
  readonly width: number;
  readonly height: number;
}
import type { AssetId } from "@ink/assets/identity.ts";
