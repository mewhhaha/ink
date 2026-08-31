import type { AssetRef } from "@ink/assets/identity.ts";
import { locale_id } from "../catalog.ts";
import { locale_chain } from "../localizer.ts";

export interface LocalizedAssetSource<Kind extends string> {
  readonly default: AssetRef<Kind>;
  readonly variants: Readonly<Record<string, AssetRef<Kind>>>;
}

export interface LocalizedAsset<Kind extends string> {
  readonly default: AssetRef<Kind>;
  readonly variants: ReadonlyMap<string, AssetRef<Kind>>;
}

export interface SelectedLocalizedAsset<Kind extends string> {
  readonly asset: AssetRef<Kind>;
  readonly locale?: string;
}

export function create_localized_asset<Kind extends string>(
  source: LocalizedAssetSource<Kind>,
): LocalizedAsset<Kind> {
  const variants = new Map<string, AssetRef<Kind>>();
  for (const [unparsed_locale, asset] of Object.entries(source.variants)) {
    const locale = locale_id(unparsed_locale);
    if (variants.has(locale)) {
      throw new Error(`localized asset repeats locale ${locale}`);
    }
    if (asset.kind !== source.default.kind) {
      throw new Error(
        `localized asset ${asset.id} kind ${asset.kind} does not match default kind ${source.default.kind}`,
      );
    }
    variants.set(locale, asset);
  }
  return Object.freeze({ default: source.default, variants });
}

export function select_localized_asset<Kind extends string>(
  localized: LocalizedAsset<Kind>,
  locale: string,
  fallback_locales: readonly string[] = [],
): SelectedLocalizedAsset<Kind> {
  for (const candidate of locale_chain(locale, fallback_locales)) {
    const asset = localized.variants.get(candidate);
    if (asset !== undefined) return Object.freeze({ asset, locale: candidate });
  }
  return Object.freeze({ asset: localized.default });
}
