import type {
  DevelopmentBuild,
  DevelopmentEdge,
  DevelopmentUnitArtifact,
  RetainedDevelopmentUnit,
} from "./compiler_api.d.ts";

export const blot_development_revision_format =
  "ink-blot-development-revision" as const;
export const blot_development_revision_version = 1 as const;

export interface BlotDevelopmentArtifactReference {
  readonly name: string;
  readonly root: string;
  readonly capabilities: readonly string[];
  readonly interface_digest: string;
  readonly implementation_digest: string;
  readonly wasm_digest: string;
  readonly artifact_source: "compiled" | "unit-cache";
  readonly wasm_path: string;
  readonly manifest_path: string;
}

export interface BlotDevelopmentRetainedUnit {
  readonly name: string;
  readonly interface_digest: string;
  readonly implementation_digest: string;
  readonly wasm_digest: string;
}

export interface BlotDevelopmentEdge {
  readonly consumer: string;
  readonly provider: string;
  readonly name: string;
}

export interface BlotDevelopmentRevisionDescriptor {
  readonly format: typeof blot_development_revision_format;
  readonly version: typeof blot_development_revision_version;
  readonly revision: string;
  readonly snapshot: {
    readonly entry_unit: string;
    readonly units: readonly BlotDevelopmentArtifactReference[];
    readonly edges: readonly BlotDevelopmentEdge[];
  };
  readonly delta: {
    readonly base_revision: string | null;
    readonly changed_units: readonly BlotDevelopmentArtifactReference[];
    readonly retained_units: readonly BlotDevelopmentRetainedUnit[];
    readonly removed_units: readonly string[];
    readonly edges: readonly BlotDevelopmentEdge[];
    readonly duration_milliseconds: number;
  };
}

export interface BlotDevelopmentArtifactLoader {
  load(path: string): Promise<Uint8Array>;
}

export interface ParsedBlotDevelopmentRevision {
  readonly revision: string;
  readonly entry_unit: string;
  readonly snapshot_units: readonly BlotDevelopmentArtifactReference[];
  readonly snapshot_edges: readonly BlotDevelopmentEdge[];
  readonly delta: BlotDevelopmentRevisionDescriptor["delta"];
}

export function parse_blot_development_revision(
  value: unknown,
): ParsedBlotDevelopmentRevision {
  const descriptor = expect_record(value, "Blot development descriptor");
  expect_fields(
    descriptor,
    ["delta", "format", "revision", "snapshot", "version"],
    "Blot development descriptor",
  );
  if (descriptor.format !== blot_development_revision_format) {
    throw new Error(
      `Blot development descriptor format ${
        JSON.stringify(descriptor.format)
      } must be ${JSON.stringify(blot_development_revision_format)}`,
    );
  }
  if (descriptor.version !== blot_development_revision_version) {
    throw new Error(
      `Blot development descriptor version ${
        JSON.stringify(descriptor.version)
      } must be ${blot_development_revision_version}`,
    );
  }
  const revision = expect_digest(
    descriptor.revision,
    "Blot development descriptor revision",
  );
  const snapshot = expect_record(
    descriptor.snapshot,
    `Blot development descriptor ${JSON.stringify(revision)} snapshot`,
  );
  expect_fields(
    snapshot,
    ["edges", "entry_unit", "units"],
    `Blot development descriptor ${JSON.stringify(revision)} snapshot`,
  );
  const entry_unit = expect_nonempty_string(
    snapshot.entry_unit,
    `Blot development descriptor ${JSON.stringify(revision)} entry unit`,
  );
  const snapshot_units = parse_artifact_references(
    snapshot.units,
    `Blot development descriptor ${JSON.stringify(revision)} snapshot units`,
  );
  const snapshot_edges = parse_edges(
    snapshot.edges,
    `Blot development descriptor ${JSON.stringify(revision)} snapshot edges`,
  );
  if (!snapshot_units.some(({ name }) => name === entry_unit)) {
    throw new Error(
      `Blot development descriptor ${
        JSON.stringify(revision)
      } snapshot omits entry unit ${JSON.stringify(entry_unit)}`,
    );
  }

  const delta_record = expect_record(
    descriptor.delta,
    `Blot development descriptor ${JSON.stringify(revision)} delta`,
  );
  expect_fields(
    delta_record,
    [
      "base_revision",
      "changed_units",
      "duration_milliseconds",
      "edges",
      "removed_units",
      "retained_units",
    ],
    `Blot development descriptor ${JSON.stringify(revision)} delta`,
  );
  const base_revision = delta_record.base_revision === null
    ? null
    : expect_digest(
      delta_record.base_revision,
      `Blot development descriptor ${JSON.stringify(revision)} base revision`,
    );
  const changed_units = parse_artifact_references(
    delta_record.changed_units,
    `Blot development descriptor ${JSON.stringify(revision)} changed units`,
  );
  const retained_units = parse_retained_units(
    delta_record.retained_units,
    `Blot development descriptor ${JSON.stringify(revision)} retained units`,
  );
  const removed_units = parse_unique_strings(
    delta_record.removed_units,
    `Blot development descriptor ${JSON.stringify(revision)} removed units`,
  );
  const edges = parse_edges(
    delta_record.edges,
    `Blot development descriptor ${JSON.stringify(revision)} delta edges`,
  );
  const duration_milliseconds = delta_record.duration_milliseconds;
  if (
    typeof duration_milliseconds !== "number" ||
    !Number.isFinite(duration_milliseconds) || duration_milliseconds < 0
  ) {
    throw new Error(
      `Blot development descriptor ${JSON.stringify(revision)} duration ${
        JSON.stringify(duration_milliseconds)
      } must be a nonnegative finite number`,
    );
  }
  const classifications = [
    ...changed_units.map(({ name }) => [name, "changed"] as const),
    ...retained_units.map(({ name }) => [name, "retained"] as const),
    ...removed_units.map((name) => [name, "removed"] as const),
  ];
  const classified = new Map<string, string>();
  for (const [name, classification] of classifications) {
    const previous = classified.get(name);
    if (previous !== undefined) {
      throw new Error(
        `Blot development descriptor ${JSON.stringify(revision)} classifies ${
          JSON.stringify(name)
        } as both ${previous} and ${classification}`,
      );
    }
    classified.set(name, classification);
  }
  if (JSON.stringify(edges) !== JSON.stringify(snapshot_edges)) {
    throw new Error(
      `Blot development descriptor ${
        JSON.stringify(revision)
      } delta and snapshot edges differ`,
    );
  }
  const snapshot_names = snapshot_units.map(({ name }) => name);
  const final_names = classifications
    .filter(([, classification]) => classification !== "removed")
    .map(([name]) => name)
    .toSorted();
  if (JSON.stringify(snapshot_names) !== JSON.stringify(final_names)) {
    throw new Error(
      `Blot development descriptor ${JSON.stringify(revision)} snapshot units ${
        JSON.stringify(snapshot_names)
      } do not match delta units ${JSON.stringify(final_names)}`,
    );
  }
  return Object.freeze({
    revision,
    entry_unit,
    snapshot_units,
    snapshot_edges,
    delta: Object.freeze({
      base_revision,
      changed_units,
      retained_units,
      removed_units,
      edges,
      duration_milliseconds,
    }),
  });
}

export function materialize_blot_development_snapshot(
  revision: ParsedBlotDevelopmentRevision,
  loader: BlotDevelopmentArtifactLoader,
): Promise<DevelopmentBuild> {
  return development_build({
    base_revision: null,
    revision: revision.revision,
    entry_unit: revision.entry_unit,
    changed_units: revision.snapshot_units,
    retained_units: [],
    removed_units: [],
    edges: revision.snapshot_edges,
    duration_milliseconds: 0,
  }, loader);
}

export function materialize_blot_development_delta(
  revision: ParsedBlotDevelopmentRevision,
  loader: BlotDevelopmentArtifactLoader,
): Promise<DevelopmentBuild> {
  return development_build({
    base_revision: revision.delta.base_revision,
    revision: revision.revision,
    entry_unit: revision.entry_unit,
    changed_units: revision.delta.changed_units,
    retained_units: revision.delta.retained_units,
    removed_units: revision.delta.removed_units,
    edges: revision.delta.edges,
    duration_milliseconds: revision.delta.duration_milliseconds,
  }, loader);
}

async function development_build(
  wire: {
    readonly base_revision: string | null;
    readonly revision: string;
    readonly entry_unit: string;
    readonly changed_units: readonly BlotDevelopmentArtifactReference[];
    readonly retained_units: readonly BlotDevelopmentRetainedUnit[];
    readonly removed_units: readonly string[];
    readonly edges: readonly BlotDevelopmentEdge[];
    readonly duration_milliseconds: number;
  },
  loader: BlotDevelopmentArtifactLoader,
): Promise<DevelopmentBuild> {
  const changedUnits: DevelopmentUnitArtifact[] = await Promise.all(
    wire.changed_units.map(async (reference) => {
      const [wasm, manifestBytes] = await Promise.all([
        loader.load(reference.wasm_path),
        loader.load(reference.manifest_path),
      ]);
      if (!(wasm instanceof Uint8Array)) {
        throw new Error(
          `Blot development artifact ${
            JSON.stringify(reference.wasm_path)
          } did not load as a Uint8Array`,
        );
      }
      if (!(manifestBytes instanceof Uint8Array)) {
        throw new Error(
          `Blot development artifact ${
            JSON.stringify(reference.manifest_path)
          } did not load as a Uint8Array`,
        );
      }
      return Object.freeze({
        name: reference.name,
        root: reference.root,
        capabilities: reference.capabilities,
        interfaceDigest: reference.interface_digest,
        implementationDigest: reference.implementation_digest,
        wasmDigest: reference.wasm_digest,
        artifactSource: reference.artifact_source,
        wasm: new Uint8Array(wasm),
        manifestBytes: new Uint8Array(manifestBytes),
      });
    }),
  );
  const retainedUnits: RetainedDevelopmentUnit[] = wire.retained_units.map(
    (unit) =>
      Object.freeze({
        name: unit.name,
        interfaceDigest: unit.interface_digest,
        implementationDigest: unit.implementation_digest,
        wasmDigest: unit.wasm_digest,
      }),
  );
  const edges: DevelopmentEdge[] = wire.edges.map((edge) =>
    Object.freeze({ ...edge })
  );
  const serializable = Object.freeze({
    baseRevision: wire.base_revision ?? undefined,
    revision: wire.revision,
    entryUnit: wire.entry_unit,
    changedUnits: Object.freeze(changedUnits),
    retainedUnits: Object.freeze(retainedUnits),
    removedUnits: Object.freeze([...wire.removed_units]),
    edges: Object.freeze(edges),
    durationMilliseconds: wire.duration_milliseconds,
  });
  return serializable;
}

function parse_artifact_references(
  value: unknown,
  context: string,
): readonly BlotDevelopmentArtifactReference[] {
  const references = expect_array(value, context).map((entry, index) => {
    const field = `${context}[${index}]`;
    const reference = expect_record(entry, field);
    expect_fields(
      reference,
      [
        "artifact_source",
        "capabilities",
        "implementation_digest",
        "interface_digest",
        "manifest_path",
        "name",
        "root",
        "wasm_digest",
        "wasm_path",
      ],
      field,
    );
    const name = expect_nonempty_string(reference.name, `${field}.name`);
    const root = expect_nonempty_string(reference.root, `${field}.root`);
    const capabilities = parse_unique_strings(
      reference.capabilities,
      `${field}.capabilities`,
    );
    const interface_digest = expect_unit_digest(
      reference.interface_digest,
      `${field}.interface_digest`,
    );
    const implementation_digest = expect_unit_digest(
      reference.implementation_digest,
      `${field}.implementation_digest`,
    );
    const wasm_digest = expect_digest(
      reference.wasm_digest,
      `${field}.wasm_digest`,
    );
    if (
      reference.artifact_source !== "compiled" &&
      reference.artifact_source !== "unit-cache"
    ) {
      throw new Error(
        `${field}.artifact_source ${
          JSON.stringify(reference.artifact_source)
        } must be "compiled" or "unit-cache"`,
      );
    }
    const wasm_path = expect_content_path(
      reference.wasm_path,
      `.ink/blot/${wasm_digest}.wasm`,
      `${field}.wasm_path`,
    );
    const manifest_path = expect_content_path(
      reference.manifest_path,
      `.ink/blot/${interface_digest}.wasm.json`,
      `${field}.manifest_path`,
    );
    return Object.freeze({
      name,
      root,
      capabilities,
      interface_digest,
      implementation_digest,
      wasm_digest,
      artifact_source: reference.artifact_source,
      wasm_path,
      manifest_path,
    });
  }).toSorted((left, right) => left.name.localeCompare(right.name));
  require_unique_names(references, context);
  return Object.freeze(references);
}

function parse_retained_units(
  value: unknown,
  context: string,
): readonly BlotDevelopmentRetainedUnit[] {
  const units = expect_array(value, context).map((entry, index) => {
    const field = `${context}[${index}]`;
    const unit = expect_record(entry, field);
    expect_fields(
      unit,
      ["implementation_digest", "interface_digest", "name", "wasm_digest"],
      field,
    );
    return Object.freeze({
      name: expect_nonempty_string(unit.name, `${field}.name`),
      interface_digest: expect_unit_digest(
        unit.interface_digest,
        `${field}.interface_digest`,
      ),
      implementation_digest: expect_unit_digest(
        unit.implementation_digest,
        `${field}.implementation_digest`,
      ),
      wasm_digest: expect_digest(unit.wasm_digest, `${field}.wasm_digest`),
    });
  }).toSorted((left, right) => left.name.localeCompare(right.name));
  require_unique_names(units, context);
  return Object.freeze(units);
}

function parse_edges(
  value: unknown,
  context: string,
): readonly BlotDevelopmentEdge[] {
  const edges = expect_array(value, context).map((entry, index) => {
    const field = `${context}[${index}]`;
    const edge = expect_record(entry, field);
    expect_fields(edge, ["consumer", "name", "provider"], field);
    return Object.freeze({
      consumer: expect_nonempty_string(edge.consumer, `${field}.consumer`),
      provider: expect_nonempty_string(edge.provider, `${field}.provider`),
      name: expect_nonempty_string(edge.name, `${field}.name`),
    });
  }).toSorted((left, right) =>
    left.consumer.localeCompare(right.consumer) ||
    left.provider.localeCompare(right.provider) ||
    left.name.localeCompare(right.name)
  );
  const identities = edges.map((edge) =>
    `${edge.consumer}\0${edge.provider}\0${edge.name}`
  );
  if (new Set(identities).size !== identities.length) {
    throw new Error(`${context} repeats an edge`);
  }
  return Object.freeze(edges);
}

function parse_unique_strings(
  value: unknown,
  context: string,
): readonly string[] {
  const strings = expect_array(value, context).map((entry, index) =>
    expect_nonempty_string(entry, `${context}[${index}]`)
  ).toSorted();
  if (new Set(strings).size !== strings.length) {
    throw new Error(`${context} repeats a value`);
  }
  return Object.freeze(strings);
}

function require_unique_names(
  entries: readonly { readonly name: string }[],
  context: string,
): void {
  const names = entries.map(({ name }) => name);
  if (new Set(names).size !== names.length) {
    throw new Error(`${context} repeats a unit name`);
  }
}

function expect_content_path(
  value: unknown,
  expected: string,
  context: string,
): string {
  if (value !== expected) {
    throw new Error(
      `${context} ${JSON.stringify(value)} must be ${JSON.stringify(expected)}`,
    );
  }
  return expected;
}

function expect_digest(value: unknown, context: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(
      `${context} ${JSON.stringify(value)} must be a lowercase SHA-256 digest`,
    );
  }
  return value;
}

function expect_unit_digest(value: unknown, context: string): string {
  if (
    typeof value !== "string" || !/^(?:[a-f0-9]{16}|[a-f0-9]{64})$/.test(value)
  ) {
    throw new Error(
      `${context} ${
        JSON.stringify(value)
      } must be a lowercase compiler content digest`,
    );
  }
  return value;
}

function expect_nonempty_string(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `${context} ${JSON.stringify(value)} must be a non-empty string`,
    );
  }
  return value;
}

function expect_array(value: unknown, context: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${context} must be an array`);
  }
  return value;
}

function expect_record(
  value: unknown,
  context: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expect_fields(
  record: Record<string, unknown>,
  expected: readonly string[],
  context: string,
): void {
  const actual = Object.keys(record).toSorted();
  if (JSON.stringify(actual) === JSON.stringify(expected)) return;
  throw new Error(
    `${context} fields ${JSON.stringify(actual)} must be ${
      JSON.stringify(expected)
    }`,
  );
}
