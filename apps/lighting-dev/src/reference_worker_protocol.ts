import type {
  LightingReferenceModel,
  PreparedLightingReference,
} from "./scene.ts";

export interface LoadedReference {
  readonly load_milliseconds: number;
  readonly model: LightingReferenceModel;
  readonly source_materials: "embedded" | "upstream-omitted";
}

export interface ReferenceLoadRequest {
  readonly reference: PreparedLightingReference;
  readonly request_id: number;
}

export type ReferenceLoadResponse =
  | {
    readonly loaded: LoadedReference;
    readonly request_id: number;
    readonly type: "loaded";
  }
  | {
    readonly reason: string;
    readonly request_id: number;
    readonly type: "failed";
  };
