declare const material_definition_id_brand: unique symbol;
declare const material_instance_id_brand: unique symbol;
declare const material_variant_id_brand: unique symbol;

export type MaterialDefinitionId = string & {
  readonly [material_definition_id_brand]: true;
};
export type MaterialInstanceId = string & {
  readonly [material_instance_id_brand]: true;
};
export type MaterialVariantId = string & {
  readonly [material_variant_id_brand]: true;
};

function stable_identity(value: string, label: string): string {
  const parsed = value.trim();
  if (parsed.length === 0 || !/^[a-zA-Z0-9_.:/-]+$/.test(parsed)) {
    throw new Error(
      `${label} ${JSON.stringify(value)} must be a nonempty stable identity`,
    );
  }
  return parsed;
}

export function material_definition_id(value: string): MaterialDefinitionId {
  return stable_identity(
    value,
    "material definition identity",
  ) as MaterialDefinitionId;
}

export function material_instance_id(value: string): MaterialInstanceId {
  return stable_identity(
    value,
    "material instance identity",
  ) as MaterialInstanceId;
}

export function material_variant_id(value: string): MaterialVariantId {
  return stable_identity(
    value,
    "material variant identity",
  ) as MaterialVariantId;
}
