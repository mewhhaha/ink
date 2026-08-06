declare const specialized_editor_id_brand: unique symbol;
declare const editor_preset_id_brand: unique symbol;
declare const editor_tool_id_brand: unique symbol;

export type SpecializedEditorId = string & {
  readonly [specialized_editor_id_brand]: true;
};
export type EditorPresetId = string & {
  readonly [editor_preset_id_brand]: true;
};
export type EditorToolId = string & {
  readonly [editor_tool_id_brand]: true;
};

export function specialized_editor_id(value: string): SpecializedEditorId {
  return stable_identity(
    value,
    "specialized editor identity",
  ) as SpecializedEditorId;
}

export function editor_preset_id(value: string): EditorPresetId {
  return stable_identity(value, "editor preset identity") as EditorPresetId;
}

export function editor_tool_id(value: string): EditorToolId {
  return stable_identity(value, "editor tool identity") as EditorToolId;
}

function stable_identity(value: string, label: string): string {
  const parsed = value.trim();
  if (!/^[a-z][a-z0-9-]*$/.test(parsed)) {
    throw new Error(
      `${label} ${JSON.stringify(value)} must use lowercase kebab-case`,
    );
  }
  return parsed;
}
