# @ink/procedural

Deterministic, game-neutral procedural synthesis for terrain, biomes, object
placement, and signed-distance meshes.

The package accepts scalar and signed-distance fields at its boundary. Noise
algorithms remain in `@ink/noise`; world streaming remains in `@ink/world`; GPU
resource ownership remains in `@ink/rendering`. This package turns authored
recipes into immutable products those systems can consume.

## Modules

- `identity.ts`: unsigned seeds, generator revisions, and coordinate-stable
  random channels.
- `heightfield.ts`: sampled heightfield baking and shared terrain adaptation.
- `noise.ts`: downstream adaptation from `@ink/noise` fractals to scalar fields.
- `biome.ts`: range/falloff classification and terrain surface maps.
- `scatter.ts`: deterministic, bounded, minimum-distance placement.
- `sdf.ts`: first-party signed-distance primitives and composition.
- `marching.ts`: marching-tetrahedra surface extraction.
- `recipe.ts`: explicit composition of terrain, biome, and scatter products.

Recipes must record their generator revision alongside their seed. A seed alone
does not promise compatibility across algorithm changes.
