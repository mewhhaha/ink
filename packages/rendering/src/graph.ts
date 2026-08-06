import type { RenderResourceDescriptor } from "./resources.ts";

export type RenderPassKind = "render" | "compute" | "copy";
export type RenderAccess =
  | "sampled"
  | "uniform"
  | "vertex"
  | "index"
  | "indirect"
  | "storage_read"
  | "storage_write"
  | "attachment"
  | "copy_source"
  | "copy_destination";

export interface RenderGraphResource {
  readonly id: string;
  readonly descriptor: RenderResourceDescriptor;
  readonly lifetime: "external" | "transient";
  readonly initial_content?: "present";
}

export interface RenderGraphRead {
  readonly resource: string;
  readonly access: Exclude<
    RenderAccess,
    "storage_write" | "attachment" | "copy_destination"
  >;
}

export interface RenderGraphWrite {
  readonly resource: string;
  readonly access: "storage_write" | "attachment" | "copy_destination";
  readonly load: "clear" | "load" | "discard";
  readonly store: "store" | "discard";
  readonly resolve?: string;
}

export interface RenderGraphPass {
  readonly id: string;
  readonly kind: RenderPassKind;
  readonly reads: readonly RenderGraphRead[];
  readonly writes: readonly RenderGraphWrite[];
  readonly after: readonly string[];
}

export interface ResourceLifetime {
  readonly resource: string;
  readonly first_pass: number;
  readonly last_pass: number;
  readonly alias_slot: number;
}

export interface CompiledRenderGraph {
  readonly resources: readonly RenderGraphResource[];
  readonly passes: readonly RenderGraphPass[];
  readonly lifetimes: readonly ResourceLifetime[];
  readonly transient_slot_count: number;
}

export interface RenderGraphCapture {
  readonly frame: number;
  readonly graph: CompiledRenderGraph;
  readonly pass_cpu_seconds: ReadonlyMap<string, number>;
  readonly pass_gpu_seconds: ReadonlyMap<string, number>;
}

export class RenderGraph {
  readonly #resources = new Map<string, RenderGraphResource>();
  readonly #passes = new Map<string, RenderGraphPass>();

  resource(resource: RenderGraphResource): this {
    const id = identity(resource.id, "graph resource");
    if (this.#resources.has(id)) {
      throw new Error(
        `render graph resource ${JSON.stringify(id)} appears more than once`,
      );
    }
    this.#resources.set(
      id,
      Object.freeze({
        ...resource,
        id,
        descriptor: { ...resource.descriptor },
      }),
    );
    return this;
  }

  pass(pass: RenderGraphPass): this {
    const id = identity(pass.id, "graph pass");
    if (this.#passes.has(id)) {
      throw new Error(
        `render graph pass ${JSON.stringify(id)} appears more than once`,
      );
    }
    this.#passes.set(
      id,
      Object.freeze({
        ...pass,
        id,
        reads: pass.reads.map((read) => ({ ...read })),
        writes: pass.writes.map((write) => ({ ...write })),
        after: [...pass.after],
      }),
    );
    return this;
  }

  compile(): CompiledRenderGraph {
    if (this.#passes.size === 0) {
      throw new Error("render graph requires at least one pass");
    }
    validate_references(this.#resources, this.#passes);
    const dependencies = build_dependencies(this.#resources, this.#passes);
    const passes = topological_passes(this.#passes, dependencies);
    validate_content(this.#resources, passes);
    const lifetimes = build_lifetimes(this.#resources, passes);
    return {
      resources: [...this.#resources.values()].sort((left, right) =>
        left.id.localeCompare(right.id)
      ),
      passes,
      lifetimes,
      transient_slot_count: lifetimes.reduce(
        (maximum, lifetime) => Math.max(maximum, lifetime.alias_slot + 1),
        0,
      ),
    };
  }
}

function validate_references(
  resources: ReadonlyMap<string, RenderGraphResource>,
  passes: ReadonlyMap<string, RenderGraphPass>,
): void {
  for (const pass of passes.values()) {
    const accesses = new Set<string>();
    for (const dependency of pass.after) {
      if (!passes.has(dependency)) {
        throw new Error(
          `render graph pass ${
            JSON.stringify(pass.id)
          } depends on missing pass ${JSON.stringify(dependency)}`,
        );
      }
      if (dependency === pass.id) {
        throw new Error(
          `render graph pass ${
            JSON.stringify(pass.id)
          } cannot depend on itself`,
        );
      }
    }
    for (const access of [...pass.reads, ...pass.writes]) {
      if (!resources.has(access.resource)) {
        throw new Error(
          `render graph pass ${
            JSON.stringify(pass.id)
          } references missing resource ${JSON.stringify(access.resource)}`,
        );
      }
      if (accesses.has(access.resource)) {
        throw new Error(
          `render graph pass ${JSON.stringify(pass.id)} accesses resource ${
            JSON.stringify(access.resource)
          } more than once`,
        );
      }
      accesses.add(access.resource);
      validate_access(pass, resources.get(access.resource)!, access.access);
    }
    for (const write of pass.writes) {
      if (write.resolve === undefined) continue;
      validate_resolve(pass, write, resources);
      if (accesses.has(write.resolve)) {
        throw new Error(
          `render graph pass ${
            JSON.stringify(pass.id)
          } accesses resolve resource ${
            JSON.stringify(write.resolve)
          } more than once`,
        );
      }
      accesses.add(write.resolve);
    }
  }
}

function validate_resolve(
  pass: RenderGraphPass,
  write: RenderGraphWrite,
  resources: ReadonlyMap<string, RenderGraphResource>,
): void {
  const source = resources.get(write.resource)!;
  const target = resources.get(write.resolve!);
  if (target === undefined) {
    throw new Error(
      `render graph pass ${
        JSON.stringify(pass.id)
      } resolves to missing resource ${JSON.stringify(write.resolve)}`,
    );
  }
  if (
    write.access !== "attachment" || source.descriptor.type !== "texture" ||
    target.descriptor.type !== "texture"
  ) {
    throw new Error(
      `render graph pass ${JSON.stringify(pass.id)} resolve ${
        JSON.stringify(write.resource)
      } -> ${JSON.stringify(write.resolve)} requires texture attachments`,
    );
  }
  if (
    source.descriptor.sample_count <= 1 ||
    target.descriptor.sample_count !== 1 ||
    source.descriptor.format !== target.descriptor.format ||
    source.descriptor.width !== target.descriptor.width ||
    source.descriptor.height !== target.descriptor.height
  ) {
    throw new Error(
      `render graph pass ${JSON.stringify(pass.id)} resolve ${
        JSON.stringify(write.resource)
      } -> ${
        JSON.stringify(write.resolve)
      } has incompatible samples, format, or extent`,
    );
  }
}

function validate_access(
  pass: RenderGraphPass,
  resource: RenderGraphResource,
  access: RenderAccess,
): void {
  const descriptor = resource.descriptor;
  if (
    (access === "attachment" || access === "sampled") &&
    descriptor.type !== "texture"
  ) {
    throw new Error(
      `render graph pass ${
        JSON.stringify(pass.id)
      } uses ${descriptor.type} resource ${
        JSON.stringify(resource.id)
      } as ${access}`,
    );
  }
  if (
    (access === "vertex" || access === "index" || access === "indirect" ||
      access === "uniform") && descriptor.type !== "buffer"
  ) {
    throw new Error(
      `render graph pass ${
        JSON.stringify(pass.id)
      } uses ${descriptor.type} resource ${
        JSON.stringify(resource.id)
      } as ${access}`,
    );
  }
  if (
    pass.kind === "copy" && access !== "copy_source" &&
    access !== "copy_destination"
  ) {
    throw new Error(
      `render graph copy pass ${
        JSON.stringify(pass.id)
      } cannot use ${access} access`,
    );
  }
}

function build_dependencies(
  resources: ReadonlyMap<string, RenderGraphResource>,
  passes: ReadonlyMap<string, RenderGraphPass>,
): ReadonlyMap<string, Set<string>> {
  const dependencies = new Map<string, Set<string>>();
  for (const pass of passes.values()) {
    dependencies.set(pass.id, new Set(pass.after));
  }
  const ordered = [...passes.values()];
  for (const resource of resources.values()) {
    let last_writer: string | undefined;
    const readers: string[] = [];
    for (const pass of ordered) {
      const reads = pass.reads.some((read) => read.resource === resource.id);
      const writes = pass.writes.some((write) =>
        write.resource === resource.id || write.resolve === resource.id
      );
      if (reads && last_writer !== undefined) {
        dependencies.get(pass.id)!.add(last_writer);
      }
      if (writes) {
        if (last_writer !== undefined) {
          dependencies.get(pass.id)!.add(last_writer);
        }
        for (const reader of readers) dependencies.get(pass.id)!.add(reader);
        last_writer = pass.id;
        readers.splice(0);
      }
      if (reads) readers.push(pass.id);
    }
  }
  return dependencies;
}

function topological_passes(
  passes: ReadonlyMap<string, RenderGraphPass>,
  dependencies: ReadonlyMap<string, Set<string>>,
): readonly RenderGraphPass[] {
  const state = new Map<string, "visiting" | "visited">();
  const ordered: RenderGraphPass[] = [];
  const visit = (id: string, path: readonly string[]): void => {
    if (state.get(id) === "visited") return;
    if (state.get(id) === "visiting") {
      throw new Error(
        `render graph contains pass cycle ${[...path, id].join(" -> ")}`,
      );
    }
    state.set(id, "visiting");
    for (const dependency of [...dependencies.get(id)!].sort()) {
      visit(dependency, [...path, id]);
    }
    state.set(id, "visited");
    ordered.push(passes.get(id)!);
  };
  for (const id of [...passes.keys()].sort()) visit(id, []);
  return ordered;
}

function validate_content(
  resources: ReadonlyMap<string, RenderGraphResource>,
  passes: readonly RenderGraphPass[],
): void {
  const initialized = new Set(
    [...resources.values()].filter((resource) =>
      resource.initial_content === "present"
    ).map((resource) => resource.id),
  );
  for (const pass of passes) {
    for (const read of pass.reads) {
      if (!initialized.has(read.resource)) {
        throw new Error(
          `render graph pass ${JSON.stringify(pass.id)} reads resource ${
            JSON.stringify(read.resource)
          } before it is written`,
        );
      }
    }
    for (const write of pass.writes) {
      if (write.load === "load" && !initialized.has(write.resource)) {
        throw new Error(
          `render graph pass ${JSON.stringify(pass.id)} loads resource ${
            JSON.stringify(write.resource)
          } before it is written`,
        );
      }
      if (write.store === "store") initialized.add(write.resource);
      else initialized.delete(write.resource);
      if (write.resolve !== undefined) initialized.add(write.resolve);
    }
  }
}

function build_lifetimes(
  resources: ReadonlyMap<string, RenderGraphResource>,
  passes: readonly RenderGraphPass[],
): readonly ResourceLifetime[] {
  const lifetimes: ResourceLifetime[] = [];
  const slots: { descriptor: string; last_pass: number }[] = [];
  for (
    const resource of [...resources.values()].filter((entry) =>
      entry.lifetime === "transient"
    ).sort((left, right) => left.id.localeCompare(right.id))
  ) {
    const indices = passes.flatMap((pass, index) =>
      [...pass.reads, ...pass.writes].some((access) =>
          access.resource === resource.id
        ) || pass.writes.some((write) => write.resolve === resource.id)
        ? [index]
        : []
    );
    if (indices.length === 0) {
      throw new Error(
        `render graph transient resource ${
          JSON.stringify(resource.id)
        } is never used`,
      );
    }
    const first_pass = Math.min(...indices);
    const last_pass = Math.max(...indices);
    const descriptor = JSON.stringify(resource.descriptor);
    let alias_slot = slots.findIndex((slot) =>
      slot.descriptor === descriptor && slot.last_pass < first_pass
    );
    if (alias_slot < 0) {
      alias_slot = slots.length;
      slots.push({ descriptor, last_pass });
    } else slots[alias_slot].last_pass = last_pass;
    lifetimes.push({
      resource: resource.id,
      first_pass,
      last_pass,
      alias_slot,
    });
  }
  return lifetimes;
}

function identity(value: string, label: string): string {
  const parsed = value.trim();
  if (parsed.length === 0) {
    throw new Error(
      `render ${label} identity ${JSON.stringify(value)} cannot be empty`,
    );
  }
  return parsed;
}
