declare const light_id_brand: unique symbol;
declare const probe_id_brand: unique symbol;
declare const environment_id_brand: unique symbol;

export type LightId = string & { readonly [light_id_brand]: true };
export type ProbeId = string & { readonly [probe_id_brand]: true };
export type EnvironmentId = string & { readonly [environment_id_brand]: true };

function stable_identity(value: string, label: string): string {
  const parsed = value.trim();
  if (parsed.length === 0 || !/^[a-zA-Z0-9_.:/-]+$/.test(parsed)) {
    throw new Error(
      `${label} ${JSON.stringify(value)} must be a nonempty stable identity`,
    );
  }
  return parsed;
}

export function light_id(value: string): LightId {
  return stable_identity(value, "light identity") as LightId;
}

export function probe_id(value: string): ProbeId {
  return stable_identity(value, "probe identity") as ProbeId;
}

export function environment_id(value: string): EnvironmentId {
  return stable_identity(value, "environment identity") as EnvironmentId;
}
