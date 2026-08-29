export type CompatibilityProjection = "perspective" | "orthographic";

export type CompatibilitySemanticPlacement =
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

interface CompatibilitySemanticRegionBase {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly element_size: {
    readonly width: number;
    readonly height: number;
  };
  readonly placement: CompatibilitySemanticPlacement;
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
}

export type CompatibilitySemanticRegion =
  | CompatibilitySemanticRegionBase & {
    readonly role: "button";
    readonly target: number;
    readonly pressed: boolean;
    readonly selected: boolean;
  }
  | CompatibilitySemanticRegionBase & { readonly role: "text" }
  | CompatibilitySemanticRegionBase & {
    readonly role: "progress";
    readonly maximum: number;
    readonly value: number;
  };

export interface CompatibilitySceneNode {
  readonly type: "scene_node";
  readonly id: number;
  readonly parent: number | null;
  readonly rotation_radians: readonly [number, number, number];
  readonly position: readonly [number, number, number];
  readonly scale: readonly [number, number, number];
  readonly visible: boolean;
}

export interface CompatibilitySceneObject {
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
  readonly surface_mode: 0 | 1 | 2 | 3 | 4;
  readonly path_connections: number;
  readonly rotation_radians: readonly [number, number, number];
  readonly position: readonly [number, number, number];
  readonly scale: readonly [number, number, number];
  readonly visible: boolean;
}

export interface CompatibilityDirectionalLight {
  readonly type: "directional_light";
  readonly color: readonly [number, number, number];
  readonly direction: readonly [number, number, number];
  readonly intensity: number;
}

export interface CompatibilityRenderSnapshot {
  readonly projection: CompatibilityProjection;
  readonly camera_zoom: number;
  readonly directional_light: CompatibilityDirectionalLight;
  readonly nodes: readonly CompatibilitySceneNode[];
  readonly objects: readonly CompatibilitySceneObject[];
}
