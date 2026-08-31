export interface DevelopmentUnitArtifact {
  readonly name: string;
  readonly root: string;
  readonly capabilities: readonly string[];
  readonly interfaceDigest: string;
  readonly implementationDigest: string;
  readonly wasmDigest: string;
  readonly wasm: Uint8Array;
  readonly manifestBytes: Uint8Array;
  readonly artifactSource: "compiled" | "unit-cache";
}

export interface RetainedDevelopmentUnit {
  readonly name: string;
  readonly interfaceDigest: string;
  readonly implementationDigest: string;
  readonly wasmDigest: string;
}

export interface DevelopmentEdge {
  readonly consumer: string;
  readonly provider: string;
  readonly name: string;
}

export interface DevelopmentBuild {
  readonly baseRevision: string | undefined;
  readonly revision: string;
  readonly entryUnit: string;
  readonly changedUnits: readonly DevelopmentUnitArtifact[];
  readonly retainedUnits: readonly RetainedDevelopmentUnit[];
  readonly removedUnits: readonly string[];
  readonly edges: readonly DevelopmentEdge[];
  readonly durationMilliseconds: number;
}

export declare class DevelopmentProject {
  static create(
    manifestPath: string,
    compilerOptions?: {
      readonly wasm?: Uint8Array;
      readonly preludeSnapshot?: Uint8Array;
    },
  ): Promise<DevelopmentProject>;
  markChanged(path: string): Promise<void>;
  prepareBuild(): Promise<DevelopmentBuild>;
  commitBuild(build: DevelopmentBuild): void;
  abortBuild(build: DevelopmentBuild): void;
  destroy(): void;
}

export interface DevelopmentActivation {
  readonly revision: string;
}

export interface DevelopmentRuntimeContext {
  readonly unit: string;
  memory(): WebAssembly.Memory;
}

export declare class DevelopmentRuntime {
  constructor(
    imports?: (
      context: DevelopmentRuntimeContext,
    ) => WebAssembly.Imports | Promise<WebAssembly.Imports>,
  );
  get revision(): string | undefined;
  get entryInstance(): WebAssembly.Instance;
  unitInstance(name: string): WebAssembly.Instance;
  prepareActivation(build: DevelopmentBuild): Promise<DevelopmentActivation>;
  commitActivation(activation: DevelopmentActivation): void;
  abortActivation(activation: DevelopmentActivation): void;
}
