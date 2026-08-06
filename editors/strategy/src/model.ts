import type { EditorPresetId } from "@ink/authoring/identity.ts";

export interface StrategyPoint {
  readonly x: number;
  readonly y: number;
}

export interface StrategyFaction {
  readonly id: string;
  readonly name: string;
  readonly relation: "player" | "ally" | "opponent" | "neutral";
}

export interface StrategyStructure {
  readonly id: string;
  readonly kind: string;
  readonly faction: string;
  readonly position: StrategyPoint;
  readonly produces?: string;
}

export interface StrategyRoute {
  readonly id: string;
  readonly points: readonly StrategyPoint[];
}

export interface StrategyWave {
  readonly id: string;
  readonly route: string;
  readonly faction: string;
  readonly unit: string;
  readonly count: number;
  readonly starts_at_seconds: number;
}

export interface StrategyObjective {
  readonly id: string;
  readonly text: string;
  readonly condition:
    | "survive-waves"
    | "destroy-target"
    | "capture"
    | "produce";
  readonly target: string;
}

export interface StrategyProject {
  readonly title: string;
  readonly preset: EditorPresetId;
  readonly width: number;
  readonly height: number;
  readonly resources: readonly string[];
  readonly factions: readonly StrategyFaction[];
  readonly structures: readonly StrategyStructure[];
  readonly routes: readonly StrategyRoute[];
  readonly waves: readonly StrategyWave[];
  readonly objectives: readonly StrategyObjective[];
}
