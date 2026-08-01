export type Projection = "perspective" | "orthographic";

export type GameAction =
  | { readonly type: "focus"; readonly target: number }
  | { readonly type: "activate"; readonly target: number }
  | { readonly type: "toggle_projection" };

export interface ActionDescription {
  readonly id: string;
  readonly label: string;
  readonly action: GameAction;
}

export interface SemanticRegion {
  readonly id: string;
  readonly role: "button";
  readonly label: string;
  readonly description: string;
  readonly bounds: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  };
  readonly order: number;
  readonly pressed: boolean;
  readonly selected: boolean;
  readonly actions: readonly ActionDescription[];
}

export interface GameStatus {
  readonly label: string;
  readonly value: string;
  readonly done: boolean;
}

export interface GameObservation {
  readonly sequence: number;
  readonly outcome: "running" | "won";
  readonly projection: Projection;
  readonly regions: readonly SemanticRegion[];
  readonly status: GameStatus;
  readonly actions: readonly ActionDescription[];
}

export type GameTraceEvent =
  | { readonly type: "initialized"; readonly sequence: 0 }
  | { readonly type: "reset"; readonly sequence: 0 }
  | {
    readonly type: "step";
    readonly sequence: number;
    readonly action: GameAction;
    readonly delta_us: number;
    readonly outcome: GameObservation["outcome"];
  }
  | {
    readonly type: "saved";
    readonly sequence: number;
    readonly checksum: string;
  }
  | { readonly type: "loaded"; readonly sequence: 0 }
  | {
    readonly type: "reloaded";
    readonly sequence: 0;
    readonly preserved: boolean;
    readonly artifact_digest: string;
  };

export interface BeaconCommand {
  readonly type: "beacon";
  readonly id: number;
  readonly lit: boolean;
  readonly selected: boolean;
  readonly position: readonly [number, number, number];
}

export interface RenderSnapshot {
  readonly projection: Projection;
  readonly beacons: readonly BeaconCommand[];
}

export interface GameViewport {
  readonly width: number;
  readonly height: number;
}

export interface GameSave {
  readonly format: "ink-save";
  readonly version: 1;
  readonly game: "scene_explorer";
  readonly artifact_digest: string;
  readonly schema_digest: string;
  readonly state: string;
  readonly random_state: string;
  readonly checksum: string;
}

export interface ReplayStep {
  readonly sequence: number;
  readonly delta_us: number;
  readonly action: GameAction;
  readonly state_digest: string;
  readonly observation_digest: string;
}

export interface GameReplay {
  readonly format: "ink-replay";
  readonly version: 1;
  readonly artifact_digest: string;
  readonly initial_save: GameSave;
  readonly steps: readonly ReplayStep[];
}
