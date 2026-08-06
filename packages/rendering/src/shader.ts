import type { Observer } from "@ink/observability/observer.ts";

export interface ShaderBinding {
  readonly group: number;
  readonly binding: number;
  readonly name: string;
  readonly visibility: readonly ("vertex" | "fragment" | "compute")[];
  readonly kind:
    | "uniform"
    | "read_only_storage"
    | "storage"
    | "texture"
    | "storage_texture"
    | "sampler"
    | "comparison_sampler";
}

export interface ShaderReflection {
  readonly vertex_entry?: string;
  readonly fragment_entry?: string;
  readonly compute_entry?: string;
  readonly bindings: readonly ShaderBinding[];
}

export interface ShaderModuleDefinition {
  readonly id: string;
  readonly revision: number;
  readonly source: string;
  readonly reflection: ShaderReflection;
}

export type ShaderCompilationResult =
  | { readonly type: "ready"; readonly module: GPUShaderModule }
  | {
    readonly type: "failed";
    readonly shader: string;
    readonly diagnostics: readonly string[];
  };

export function validate_shader(
  definition: ShaderModuleDefinition,
): ShaderModuleDefinition {
  if (definition.id.trim().length === 0) {
    throw new Error(
      `render shader identity ${JSON.stringify(definition.id)} cannot be empty`,
    );
  }
  if (!Number.isSafeInteger(definition.revision) || definition.revision < 0) {
    throw new Error(
      `render shader ${JSON.stringify(definition.id)} revision ${
        JSON.stringify(definition.revision)
      } must be nonnegative`,
    );
  }
  if (definition.source.trim().length === 0) {
    throw new Error(
      `render shader ${JSON.stringify(definition.id)} source cannot be empty`,
    );
  }
  const entries = [
    definition.reflection.vertex_entry,
    definition.reflection.fragment_entry,
    definition.reflection.compute_entry,
  ].filter((entry): entry is string => entry !== undefined);
  if (entries.length === 0) {
    throw new Error(
      `render shader ${
        JSON.stringify(definition.id)
      } needs at least one entry point`,
    );
  }
  for (const entry of entries) {
    if (
      !new RegExp(`\\bfn\\s+${escape_expression(entry)}\\b`).test(
        definition.source,
      )
    ) {
      throw new Error(
        `render shader ${JSON.stringify(definition.id)} entry point ${
          JSON.stringify(entry)
        } is absent from WGSL source`,
      );
    }
  }
  const slots = new Set<string>();
  for (const binding of definition.reflection.bindings) {
    const slot = `${binding.group}:${binding.binding}`;
    if (slots.has(slot)) {
      throw new Error(
        `render shader ${
          JSON.stringify(definition.id)
        } repeats binding ${slot}`,
      );
    }
    slots.add(slot);
    if (binding.visibility.length === 0) {
      throw new Error(
        `render shader ${
          JSON.stringify(definition.id)
        } binding ${slot} has no visibility`,
      );
    }
  }
  return Object.freeze({
    ...definition,
    reflection: {
      ...definition.reflection,
      bindings: definition.reflection.bindings.map((binding) => ({
        ...binding,
        visibility: [...binding.visibility],
      })),
    },
  });
}

export async function compile_shader(
  device: GPUDevice,
  definition: ShaderModuleDefinition,
): Promise<ShaderCompilationResult> {
  const shader = validate_shader(definition);
  const module = device.createShaderModule({
    label: shader.id,
    code: shader.source,
  });
  const compilation = await module.getCompilationInfo();
  const errors = compilation.messages.filter((entry) => entry.type === "error")
    .map((entry) =>
      `${shader.id}:${entry.lineNum}:${entry.linePos}: ${entry.message}`
    );
  return errors.length === 0
    ? { type: "ready", module }
    : { type: "failed", shader: shader.id, diagnostics: errors };
}

export interface PipelineCacheEntry<Value> {
  readonly key: string;
  readonly value: Value;
  readonly last_used_frame: number;
}

export class PipelineCache<Value> {
  readonly #maximum_entries: number;
  readonly #observer: Observer | undefined;
  readonly #entries = new Map<string, PipelineCacheEntry<Value>>();
  #misses = 0;

  constructor(maximum_entries: number, observer?: Observer) {
    if (!Number.isSafeInteger(maximum_entries) || maximum_entries <= 0) {
      throw new Error(
        `render pipeline cache maximum ${
          JSON.stringify(maximum_entries)
        } must be positive`,
      );
    }
    this.#maximum_entries = maximum_entries;
    this.#observer = observer;
  }

  acquire(key: string, frame: number, create: () => Value): Value {
    const parsed = key.trim();
    if (parsed.length === 0) {
      throw new Error(
        `render pipeline key ${JSON.stringify(key)} cannot be empty`,
      );
    }
    if (!Number.isSafeInteger(frame) || frame < 0) {
      throw new Error(
        `render pipeline frame ${JSON.stringify(frame)} must be nonnegative`,
      );
    }
    const current = this.#entries.get(parsed);
    if (current !== undefined) {
      this.#entries.set(parsed, { ...current, last_used_frame: frame });
      return current.value;
    }
    let value: Value;
    try {
      value = create();
    } catch (error) {
      throw new Error(
        `render pipeline ${JSON.stringify(parsed)} creation failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    this.#misses += 1;
    this.#entries.set(parsed, { key: parsed, value, last_used_frame: frame });
    this.#evict();
    this.#observer?.event("render.pipeline.miss", { pipeline: parsed, frame });
    return value;
  }

  get misses(): number {
    return this.#misses;
  }

  entries(): readonly PipelineCacheEntry<Value>[] {
    return [...this.#entries.values()].sort((left, right) =>
      left.key.localeCompare(right.key)
    );
  }

  clear(): readonly Value[] {
    const values = this.entries().map((entry) => entry.value);
    this.#entries.clear();
    return values;
  }

  #evict(): void {
    while (this.#entries.size > this.#maximum_entries) {
      const oldest = [...this.#entries.values()].sort((left, right) =>
        left.last_used_frame - right.last_used_frame ||
        left.key.localeCompare(right.key)
      )[0];
      this.#entries.delete(oldest.key);
    }
  }
}

export const pbr_shader_module: ShaderModuleDefinition = validate_shader({
  id: "ink/pbr",
  revision: 0,
  reflection: {
    vertex_entry: "vertex_main",
    fragment_entry: "fragment_main",
    bindings: [
      {
        group: 0,
        binding: 0,
        name: "frame",
        visibility: ["vertex", "fragment"],
        kind: "uniform",
      },
      {
        group: 1,
        binding: 0,
        name: "material",
        visibility: ["fragment"],
        kind: "uniform",
      },
    ],
  },
  source: `
struct Frame { view_projection: mat4x4f }
struct Material { base_color: vec4f, metallic: f32, roughness: f32, specular: f32 }
@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<uniform> material: Material;
struct VertexOutput { @builtin(position) position: vec4f, @location(0) normal: vec3f }
@vertex fn vertex_main(@location(0) position: vec3f, @location(1) normal: vec3f) -> VertexOutput {
  var output: VertexOutput;
  output.position = frame.view_projection * vec4f(position, 1.0);
  output.normal = normal;
  return output;
}
fn distribution_ggx(no_h: f32, roughness: f32) -> f32 {
  let alpha = roughness * roughness;
  let denominator = no_h * no_h * (alpha * alpha - 1.0) + 1.0;
  return alpha * alpha / max(3.14159265 * denominator * denominator, 0.00001);
}
fn fresnel_schlick(vo_h: f32, f0: vec3f) -> vec3f {
  return f0 + (vec3f(1.0) - f0) * pow(1.0 - vo_h, 5.0);
}
@fragment fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let normal = normalize(input.normal);
  let light = normalize(vec3f(0.4, 0.8, 0.2));
  let no_l = max(dot(normal, light), 0.0);
  let f0 = mix(vec3f(0.04 * material.specular), material.base_color.rgb, material.metallic);
  return vec4f((material.base_color.rgb * (1.0 - material.metallic) + fresnel_schlick(no_l, f0)) * no_l, material.base_color.a);
}`,
});

function escape_expression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
