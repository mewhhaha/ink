declare const effect_definition_id_brand: unique symbol;
declare const effect_instance_id_brand: unique symbol;
declare const emitter_id_brand: unique symbol;

export type EffectDefinitionId = string & {
  readonly [effect_definition_id_brand]: true;
};
export type EffectInstanceId = string & {
  readonly [effect_instance_id_brand]: true;
};
export type EmitterId = string & { readonly [emitter_id_brand]: true };

export function effect_definition_id(value: string): EffectDefinitionId {
  return stable_identity(
    value,
    "effect definition identity",
  ) as EffectDefinitionId;
}

export function effect_instance_id(value: string): EffectInstanceId {
  return stable_identity(value, "effect instance identity") as EffectInstanceId;
}

export function emitter_id(value: string): EmitterId {
  return stable_identity(value, "effect emitter identity") as EmitterId;
}

function stable_identity(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} ${JSON.stringify(value)} must be a string`);
  }
  const parsed = value.trim();
  if (parsed.length === 0 || !/^[a-zA-Z0-9_.:/-]+$/.test(parsed)) {
    throw new Error(
      `${label} ${JSON.stringify(value)} must be a nonempty stable identity`,
    );
  }
  return parsed;
}
