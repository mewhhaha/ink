import type {
  EditorPresetId,
  EditorToolId,
  SpecializedEditorId,
} from "./identity.ts";

export interface EditorToolDescriptor {
  readonly id: EditorToolId;
  readonly label: string;
  readonly purpose: string;
  readonly shortcut?: string;
}

export interface EditorPresetDescriptor {
  readonly id: EditorPresetId;
  readonly label: string;
  readonly summary: string;
  readonly characteristic_mechanics: readonly string[];
}

export interface SpecializedEditorDescriptor {
  readonly id: SpecializedEditorId;
  readonly label: string;
  readonly summary: string;
  readonly vocabulary: readonly string[];
  readonly tools: readonly EditorToolDescriptor[];
  readonly presets: readonly EditorPresetDescriptor[];
}

export function specialized_editor_descriptor(
  descriptor: SpecializedEditorDescriptor,
): SpecializedEditorDescriptor {
  const label = required_text(
    descriptor.label,
    `editor ${descriptor.id} label`,
  );
  const summary = required_text(
    descriptor.summary,
    `editor ${descriptor.id} summary`,
  );
  if (descriptor.tools.length === 0) {
    throw new Error(`editor ${descriptor.id} needs at least one creator tool`);
  }
  if (descriptor.presets.length === 0) {
    throw new Error(`editor ${descriptor.id} needs at least one preset`);
  }
  unique(descriptor.tools.map(({ id }) => id), `editor ${descriptor.id} tool`);
  unique(
    descriptor.presets.map(({ id }) => id),
    `editor ${descriptor.id} preset`,
  );
  const vocabulary = descriptor.vocabulary.map((word, index) =>
    required_text(word, `editor ${descriptor.id} vocabulary ${index}`)
  );
  unique(vocabulary, `editor ${descriptor.id} vocabulary`);
  return Object.freeze({
    ...descriptor,
    label,
    summary,
    vocabulary: Object.freeze(vocabulary),
    tools: Object.freeze(descriptor.tools.map((tool) =>
      Object.freeze({
        ...tool,
        label: required_text(tool.label, `editor tool ${tool.id} label`),
        purpose: required_text(tool.purpose, `editor tool ${tool.id} purpose`),
      })
    )),
    presets: Object.freeze(descriptor.presets.map((preset) =>
      Object.freeze({
        ...preset,
        label: required_text(preset.label, `editor preset ${preset.id} label`),
        summary: required_text(
          preset.summary,
          `editor preset ${preset.id} summary`,
        ),
        characteristic_mechanics: Object.freeze(
          preset.characteristic_mechanics.map((mechanic, index) =>
            required_text(
              mechanic,
              `editor preset ${preset.id} mechanic ${index}`,
            )
          ),
        ),
      })
    )),
  });
}

function required_text(value: string, label: string): string {
  const parsed = value.trim();
  if (parsed.length === 0) throw new Error(`${label} cannot be empty`);
  return parsed;
}

function unique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${label} repeats ${value}`);
    seen.add(value);
  }
}
