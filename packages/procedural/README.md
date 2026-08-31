# @ink/procedural

The stable surface is the deterministic recipe and scatter path exercised by the
strategy editor game:

- `identity.ts` owns recipe seeds and revisions.
- `recipe.ts` binds one seed and revision to a scatter recipe.
- `scatter.ts` validates recipes and produces separated points.

Biomes, heightfields, marching surfaces, noise adapters, and signed-distance
fields remain under `@ink/procedural/experimental/*`.
