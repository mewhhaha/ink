import type { EditorPresetId } from "../../../packages/authoring/src/identity.ts";
export interface NarrativeCondition {
  readonly variable: string;
  readonly equals: number;
}
export interface NarrativeChoice {
  readonly id: string;
  readonly label: string;
  readonly destination: string;
  readonly conditions: readonly NarrativeCondition[];
  readonly reveals_evidence: string | null;
}
export interface NarrativeBeat {
  readonly id: string;
  readonly speaker: string;
  readonly text: string;
}
export interface NarrativeScene {
  readonly id: string;
  readonly beats: readonly NarrativeBeat[];
  readonly choices: readonly NarrativeChoice[];
}
export interface NarrativeVariable {
  readonly id: string;
  readonly initial: number;
}
export interface NarrativeEvidence {
  readonly id: string;
  readonly label: string;
}
export interface NarrativeEnding {
  readonly id: string;
  readonly scene: string;
  readonly label: string;
}
export interface NarrativeProject {
  readonly revision: number;
  readonly preset: EditorPresetId;
  readonly initial_scene: string;
  readonly scenes: readonly NarrativeScene[];
  readonly variables: readonly NarrativeVariable[];
  readonly evidence: readonly NarrativeEvidence[];
  readonly endings: readonly NarrativeEnding[];
}
