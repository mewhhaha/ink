declare const platformer_project_id_brand: unique symbol;
declare const platformer_level_id_brand: unique symbol;
declare const platformer_layer_id_brand: unique symbol;
declare const platformer_record_id_brand: unique symbol;
declare const platformer_connection_id_brand: unique symbol;

export type PlatformerProjectId = string & {
  readonly [platformer_project_id_brand]: true;
};
export type PlatformerLevelId = string & {
  readonly [platformer_level_id_brand]: true;
};
export type PlatformerLayerId = string & {
  readonly [platformer_layer_id_brand]: true;
};
export type PlatformerRecordId = string & {
  readonly [platformer_record_id_brand]: true;
};
export type PlatformerConnectionId = string & {
  readonly [platformer_connection_id_brand]: true;
};

export function platformer_project_id(value: string): PlatformerProjectId {
  return stable_identity(value, "platformer project") as PlatformerProjectId;
}

export function platformer_level_id(value: string): PlatformerLevelId {
  return stable_identity(value, "platformer level") as PlatformerLevelId;
}

export function platformer_layer_id(value: string): PlatformerLayerId {
  return stable_identity(value, "platformer layer") as PlatformerLayerId;
}

export function platformer_record_id(value: string): PlatformerRecordId {
  return stable_identity(value, "platformer record") as PlatformerRecordId;
}

export function platformer_connection_id(
  value: string,
): PlatformerConnectionId {
  return stable_identity(
    value,
    "platformer connection",
  ) as PlatformerConnectionId;
}

function stable_identity(value: string, label: string): string {
  const parsed = value.trim();
  if (!/^[a-z][a-z0-9-]*$/.test(parsed)) {
    throw new Error(
      `${label} identity ${
        JSON.stringify(value)
      } must use lowercase kebab-case`,
    );
  }
  return parsed;
}
