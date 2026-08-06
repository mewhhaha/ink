declare const shader_module_id_brand: unique symbol;
declare const shader_variant_key_brand: unique symbol;

export type ShaderModuleId = string & {
  readonly [shader_module_id_brand]: true;
};

export type ShaderVariantKey = string & {
  readonly [shader_variant_key_brand]: true;
};

export function shader_module_id(value: string): ShaderModuleId {
  const parsed = value.trim();
  if (parsed.length === 0 || !/^[a-zA-Z0-9_.:/-]+$/.test(parsed)) {
    throw new Error(
      `shader module identity ${
        JSON.stringify(value)
      } must be nonempty and stable`,
    );
  }
  return parsed as ShaderModuleId;
}

export function shader_variant_key(value: string): ShaderVariantKey {
  const parsed = value.trim();
  if (parsed.length === 0) {
    throw new Error(
      `shader variant key ${JSON.stringify(value)} cannot be empty`,
    );
  }
  return parsed as ShaderVariantKey;
}

export function shader_identifier(value: string, label: string): string {
  const parsed = value.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(parsed)) {
    throw new Error(
      `${label} ${JSON.stringify(value)} must be a valid WGSL identifier`,
    );
  }
  return parsed;
}
