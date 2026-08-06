import type { ShaderModuleId, ShaderVariantKey } from "./identity.ts";

export type ShaderStage = "vertex" | "fragment" | "compute";
export type ShaderSymbolKind = "function" | "struct" | "global";
export type ShaderBindingKind =
  | "uniform"
  | "read_only_storage"
  | "storage"
  | "texture"
  | "storage_texture"
  | "sampler"
  | "comparison_sampler";
export type ShaderOverrideType = "bool" | "i32" | "u32" | "f32";
export type ShaderOverrideValue = boolean | number;

export interface ShaderDependency {
  readonly module: ShaderModuleId;
  readonly symbols?: readonly string[];
}

export interface ShaderSymbolDeclaration {
  readonly name: string;
  readonly kind: ShaderSymbolKind;
  readonly exported: boolean;
}

export interface ShaderOverrideDeclaration {
  readonly name: string;
  readonly type: ShaderOverrideType;
  readonly default_value: ShaderOverrideValue;
}

export interface ShaderBindingDeclaration {
  readonly group: number;
  readonly binding: number;
  readonly name: string;
  readonly kind: ShaderBindingKind;
  readonly stages: readonly ShaderStage[];
  readonly value_type: string;
}

export interface ShaderEntryPoint {
  readonly stage: ShaderStage;
  readonly name: string;
}

export interface WgslModuleInput {
  readonly id: ShaderModuleId;
  readonly revision: number;
  readonly source: string;
  readonly dependencies?: readonly ShaderDependency[];
  readonly symbols?: readonly ShaderSymbolDeclaration[];
  readonly overrides?: readonly ShaderOverrideDeclaration[];
  readonly bindings?: readonly ShaderBindingDeclaration[];
  readonly entry_points?: readonly ShaderEntryPoint[];
}

export interface WgslModule {
  readonly id: ShaderModuleId;
  readonly revision: number;
  readonly source: string;
  readonly dependencies: readonly ShaderDependency[];
  readonly symbols: readonly ShaderSymbolDeclaration[];
  readonly overrides: readonly ShaderOverrideDeclaration[];
  readonly bindings: readonly ShaderBindingDeclaration[];
  readonly entry_points: readonly ShaderEntryPoint[];
}

export type ShaderVariantField =
  | {
    readonly name: string;
    readonly type: "boolean";
    readonly default_value: boolean;
  }
  | {
    readonly name: string;
    readonly type: "integer";
    readonly minimum: number;
    readonly maximum: number;
    readonly default_value: number;
  }
  | {
    readonly name: string;
    readonly type: "number";
    readonly minimum: number;
    readonly maximum: number;
    readonly default_value: number;
  }
  | {
    readonly name: string;
    readonly type: "enum";
    readonly values: readonly string[];
    readonly default_value: string;
  };

export interface ShaderVariantSchema {
  readonly id: string;
  readonly fields: readonly ShaderVariantField[];
}

export type ShaderVariantValue = boolean | number | string;

export interface ResolvedShaderVariant {
  readonly key: ShaderVariantKey;
  readonly values: Readonly<Record<string, ShaderVariantValue>>;
}

export interface ShaderSourceSegment {
  readonly module: ShaderModuleId;
  readonly generated_start_line: number;
  readonly generated_end_line: number;
  readonly source_start_line: number;
}

export interface ComposedShaderSource {
  readonly roots: readonly ShaderModuleId[];
  readonly modules: readonly WgslModule[];
  readonly source: string;
  readonly source_map: readonly ShaderSourceSegment[];
  readonly symbols: readonly ShaderSymbolDeclaration[];
  readonly overrides: readonly ShaderOverrideDeclaration[];
  readonly bindings: readonly ShaderBindingDeclaration[];
  readonly entry_points: readonly ShaderEntryPoint[];
  readonly variant?: ResolvedShaderVariant;
}

export interface ShaderProgramContract {
  readonly source: ComposedShaderSource;
  readonly vertex_entry?: string;
  readonly fragment_entry?: string;
  readonly compute_entry?: string;
}
